// dsh-autossh —— DSH 启动时自动寻找对端主机并建立 SSH 双向隧道，断线自愈。
//
// 为什么需要它：
//   ssh -R 绑定的远端端口只活在【当前这条 SSH 会话】上 —— 会话一断，对端监听即消失。
//   没有守护的话，SSH 方案比 adb 方案更脆。这个插件把「起隧道 + 挂了重连」做进 DSH 生命周期。
//
// 一条连接同时给出两个方向：
//   -L <手机端口>:127.0.0.1:3080   手机 → 对端的 DSH
//   -R <对端端口>:127.0.0.1:3080   对端 → 手机的 DSH（-R 的 dial 目标在手机侧解析）
//
// 三条硬约束（与 dsh-poke 一致）：
//   1) apply() 绝不抛异常 —— 插件加载失败会让 profile 起不来
//   2) 所有副作用吞掉异常
//   3) 自动寻找必须用【真实协议】判定（读 SSH banner），不能用 TCP connect 成功当依据
//      —— 本容器有 Clash TUN，任何 connect 都会"成功"

import net from 'node:net'
import fs from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tunnel'
export const inject = ['tools']

const DEFAULTS = {
  enabled: true,
  user: '',
  keyPath: '',
  sshPort: 22,
  knownHost: '',
  scanSubnet: '',
  scanEnabled: true,
  scanTimeoutMs: 900,
  scanConcurrency: 48,
  tickMs: 20000,
  retryCooldownMs: 8000,
  localProbeUrl: 'http://127.0.0.1:13085/',
  forwards: [
    { flag: 'L', bind: '13085', target: '127.0.0.1:3080' },
    { flag: 'R', bind: '18085', target: '127.0.0.1:3080' },
    { flag: 'R', bind: '18086', target: '127.0.0.1:3081' },
  ],
}

const TAG = '[tunnel] '
function note(ctx, msg) {
  try { ctx.logger?.info?.(TAG + msg) } catch { /* ignore */ }
}

function resolveConfig(ctx, config) {
  const fromCtx = (() => { try { return ctx && ctx.config } catch { return undefined } })()
  const merged = { ...DEFAULTS, ...(fromCtx && typeof fromCtx === 'object' ? fromCtx : {}), ...(config && typeof config === 'object' ? config : {}) }
  for (const k of Object.keys(DEFAULTS)) {
    const d = DEFAULTS[k]
    if (typeof d === 'number' && !Number.isFinite(merged[k])) merged[k] = d
    if (typeof d === 'string' && typeof merged[k] !== 'string') merged[k] = d
    if (typeof d === 'boolean' && typeof merged[k] !== 'boolean') merged[k] = d
  }
  if (!Array.isArray(merged.forwards) || merged.forwards.length === 0) merged.forwards = DEFAULTS.forwards
  return merged
}

/** 读 SSH banner —— 唯一可信的「这台主机跑着 SSH」判据。 */
export function readSshBanner(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy() } catch { /* ignore */ } resolve(ok) }
    let sock
    try { sock = net.connect({ host, port }) } catch { return resolve(false) }
    let buf = ''
    const timer = setTimeout(() => finish(false), timeoutMs)
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      if (buf.length >= 4) {
        clearTimeout(timer)
        // 真实协议证据：SSH 服务器会主动发 "SSH-2.0-..." 这样的标识行
        finish(buf.startsWith('SSH-'))
      }
    })
    sock.once('error', () => { clearTimeout(timer); finish(false) })
    sock.once('timeout', () => { clearTimeout(timer); finish(false) })
    sock.once('close', () => { clearTimeout(timer); finish(false) })
  })
}

/** 真连一次确认公钥可用（banner 只说明有 sshd，不说明我们能登进去）。 */
function probeAuth(host, cfg) {
  return new Promise((resolve) => {
    try {
      execFile('ssh', [
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=6', '-i', cfg.keyPath, '-p', String(cfg.sshPort),
        `${cfg.user}@${host}`, 'exit 0',
      ], { timeout: 12000 }, (err) => resolve(!err))
    } catch { resolve(false) }
  })
}

/** 并发扫描一个 /24，先用 banner 找候选，再逐个真连确认。 */
async function discover(ctx, cfg) {
  if (cfg.knownHost) {
    note(ctx, `先试已知主机 ${cfg.knownHost}`)
    if (await readSshBanner(cfg.knownHost, cfg.sshPort, 1500)) {
      if (await probeAuth(cfg.knownHost, cfg)) return cfg.knownHost
      note(ctx, `${cfg.knownHost} 有 sshd 但公钥不通，继续扫描`)
    }
  }
  if (!cfg.scanEnabled || !cfg.scanSubnet) return ''

  const hosts = []
  for (let i = 1; i <= 254; i++) hosts.push(`${cfg.scanSubnet}.${i}`)
  note(ctx, `扫描 ${cfg.scanSubnet}.0/24 找 SSH（banner 判定，非 TCP connect）`)

  const candidates = []
  let idx = 0
  const workers = Array.from({ length: Math.min(cfg.scanConcurrency, hosts.length) }, async () => {
    while (idx < hosts.length) {
      const h = hosts[idx++]
      if (await readSshBanner(h, cfg.sshPort, cfg.scanTimeoutMs)) candidates.push(h)
    }
  })
  await Promise.all(workers)
  note(ctx, `banner 命中 ${candidates.length} 台: ${candidates.slice(0, 8).join(', ') || '(无)'}`)

  for (const h of candidates) {
    if (await probeAuth(h, cfg)) return h
  }
  return ''
}

function buildArgs(host, cfg) {
  const args = [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-i', cfg.keyPath,
    '-p', String(cfg.sshPort),
  ]
  for (const f of cfg.forwards) {
    if (!f || !f.flag || !f.bind || !f.target) continue
    args.push(`-${f.flag}`, `${f.bind}:${f.target}`)
  }
  args.push(`${cfg.user}@${host}`)
  return args
}

/** 插件状态（每个实例一份）。 */
function createState(cfg) {
  return { child: null, host: '', startedAt: 0, lastExit: null, lastAttemptAt: 0, lastError: '', busy: false }
}

function spawnTunnel(ctx, cfg, state, host) {
  const args = buildArgs(host, cfg)
  let proc
  try { proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (e) {
    state.lastError = String((e && e.message) || e); return
  }
  state.child = proc
  state.host = host
  state.startedAt = Date.now()
  let err = ''
  try {
    proc.stderr?.on('data', (d) => { err = (err + d.toString()).slice(-500) })
    proc.on('exit', (code, signal) => {
      if (state.child === proc) { state.child = null; state.host = '' }
      state.lastExit = { code, signal, stderr: err.slice(-300), at: Date.now() }
    })
    proc.on('error', (e) => {
      if (state.child === proc) { state.child = null; state.host = '' }
      state.lastError = String((e && e.message) || e)
    })
  } catch { /* ignore */ }
  note(ctx, `已拉起 ssh → ${host}（pid ${proc.pid}），转发 ${cfg.forwards.length} 条`)
}

/** 一次守护动作：没隧道就发现并建立。带冷却，避免疯狂重试。 */
async function tick(ctx, cfg, state) {
  try {
    if (state.busy) return
    if (state.child) return
    const now = Date.now()
    if (now - state.lastAttemptAt < cfg.retryCooldownMs) return
    state.busy = true
    state.lastAttemptAt = now
    try {
      const host = await discover(ctx, cfg)
      if (!host) { state.lastError = '未发现可用的 SSH 主机'; note(ctx, state.lastError); return }
      spawnTunnel(ctx, cfg, state, host)
    } finally { state.busy = false }
  } catch (e) {
    try { note(ctx, '守护异常: ' + String((e && e.message) || e)) } catch { /* ignore */ }
  }
}

async function probeLocal(cfg) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 4000)
    const r = await fetch(cfg.localProbeUrl, { signal: c.signal })
    clearTimeout(t)
    return { ok: true, status: r.status }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

function statusText(cfg, state, probe) {
  const up = !!state.child
  const aliveMs = state.startedAt ? Date.now() - state.startedAt : 0
  const lines = [
    `隧道进程: ${up ? `✅ 存活（pid ${state.child.pid}，${Math.round(aliveMs / 1000)} 秒）` : '❌ 未运行'}`,
    `对端主机: ${state.host || '(未确定)'}`,
    `转发规则: ${cfg.forwards.map((f) => `-${f.flag} ${f.bind}→${f.target}`).join('  ')}`,
    `本机探针: ${probe.ok ? `✅ ${cfg.localProbeUrl} → HTTP ${probe.status}` : `❌ ${probe.error}`}`,
  ]
  if (state.lastExit) lines.push(`上次退出: code=${state.lastExit.code} signal=${state.lastExit.signal} ${state.lastExit.stderr ? '| ' + state.lastExit.stderr.replace(/\s+/g, ' ').slice(0, 160) : ''}`)
  if (state.lastError) lines.push(`最近错误: ${state.lastError}`)
  return lines.join('\n')
}

export function apply(ctx, config) {
  try {
    const cfg = resolveConfig(ctx, config)
    if (!cfg.enabled) { note(ctx, 'enabled=false，保持静默'); return }
    // 未配置就不启动 —— 空值绝不能拼出 `@host` 或去 stat 一个空路径
    if (!cfg.user || !cfg.keyPath) { note(ctx, '未配置 user/keyPath，保持静默'); return }
    if (!fs.existsSync(cfg.keyPath)) { note(ctx, `私钥不存在: ${cfg.keyPath}，保持静默`); return }

    const state = createState(cfg)

    try {
      ctx.effect(() => {
        const timer = setInterval(() => { void tick(ctx, cfg, state) }, cfg.tickMs)
        void tick(ctx, cfg, state)
        return () => {
          clearInterval(timer)
          try { state.child?.kill('SIGTERM') } catch { /* ignore */ }
          state.child = null
        }
      }, 'tunnel: SSH 隧道守护')
      note(ctx, `守护已启动（每 ${cfg.tickMs} ms），目标 ${cfg.user}@${cfg.knownHost}`)
    } catch (e) { note(ctx, '启动守护失败: ' + String((e && e.message) || e)) }

    try {
      const textOutput = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }
      ctx.tools.register(defineTool({
        name: 'tunnel_status',
        description: '查看 SSH 双向隧道的状态：进程是否存活、对端主机、转发规则、本机探针结果、上次退出原因。',
        parameters: {},
        output: textOutput,
        async execute() { return statusText(cfg, state, await probeLocal(cfg)) },
      }))
      ctx.tools.register(defineTool({
        name: 'tunnel_restart',
        description: '强制重建 SSH 隧道：杀掉现有连接，立刻重新发现对端并连接。链路疑似卡死时用。',
        parameters: {},
        output: textOutput,
        async execute() {
          try { state.child?.kill('SIGTERM') } catch { /* ignore */ }
          state.child = null
          state.host = ''
          state.lastAttemptAt = 0
          await tick(ctx, cfg, state)
          return statusText(cfg, state, await probeLocal(cfg))
        },
      }))
      note(ctx, '工具已注册: tunnel_status / tunnel_restart')
    } catch (e) { note(ctx, '注册工具失败: ' + String((e && e.message) || e)) }
  } catch (e) {
    try { console.error(TAG + 'apply 异常（已忽略）: ' + String((e && e.stack) || e)) } catch { /* ignore */ }
  }
}
