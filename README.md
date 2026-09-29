# dsh-autossh

**DeepSeek Harness 插件：DSH 启动时自动寻找对端主机并建立 SSH 双向隧道，断线后自愈。**

一条 SSH 连接同时给出两个方向 —— 本机到对端、对端到本机。插件在 `apply()` 时执行一次守护动作，
此后每 `tickMs` 检查一次；进程死了就重新发现、重连。

对端的发现**只用真实协议判定**：先读 SSH banner，再真连一次确认。

## 它解决什么问题

`ssh -R` 绑定的远端端口**只活在当前这条 SSH 会话上** —— 会话一断，对端的监听立即消失。
所以「把链路主力切到 SSH」这件事如果没有守护，反而比 adb 方案更脆。

这个插件把「起隧道 + 挂了重连」做进 DSH 生命周期：**DSH 一起来就连上，断了自动恢复。**

另一个常见动机：对端（比如一台 PC）有防火墙、不接受入站连接，只有本机能主动连出去。
那就让本机发起 SSH，用 `-R` 把对端的端口反向映射回来 —— 对端不需要跑任何脚本。

## 三个能力

| 能力 | 实现 |
| --- | --- |
| **启动即连** | `apply()` 里跑一次守护动作：发现对端并拉起 `ssh -N` |
| **断线自愈** | 每 `tickMs`（默认 20 秒）检查；进程不在就重新发现并重连（带冷却，避免疯狂重试） |
| **真实协议发现** | 先试 `knownHost`，失败则并发扫 `scanSubnet`；**读 SSH banner** 找候选，再用 `ssh -o BatchMode=yes … exit 0` 真连确认 |

一条连接，多条转发：

```bash
ssh -N -L 13085:127.0.0.1:3080 -R 18085:127.0.0.1:3080 -R 18086:127.0.0.1:3081 user@peer
#        └─ 本机 13085 → 对端 3080      └─ 对端 18085 → 本机 3080   └─ 对端 18086 → 本机 3081
```

> ⚠️ `-R` 的 dial 目标是在**发起端**解析的，不是在对端。`-R 18085:127.0.0.1:3080` 的含义是：
> 对端监听 18085，收到连接后把数据经加密通道送回本机，由**本机的 ssh 客户端**去连**本机的** 3080。
> 所以对端不需要监听 3080 供这个转发使用。

两个模型可见工具：

- `tunnel_status` —— 隧道进程是否存活、对端主机、转发规则、本机探针、上次退出原因
- `tunnel_restart` —— 强制重建：杀掉现有连接，立刻重新发现并连接

## 安装

```bash
dsh plugin --profile web add dsh-autossh
```

或从本地目录：

```bash
dsh plugin --profile web add file:/path/to/dsh-autossh
```

## 配置

写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: tunnel
  name: dsh-autossh
  config:
    enabled: true
    user: your-user                    # 对端登录名
    keyPath: /root/.ssh/id_ed25519     # 免密私钥（BatchMode=yes 无法交互输入口令）
    sshPort: 22
    knownHost: 192.168.1.10            # 先试它
    scanSubnet: 192.168.1               # 试不通就并发扫这个 /24
    scanEnabled: true
    scanTimeoutMs: 900
    scanConcurrency: 48
    tickMs: 20000
    retryCooldownMs: 8000
    localProbeUrl: http://127.0.0.1:13085/
    forwards:
      - { flag: L, bind: "13085", target: "127.0.0.1:3080" }
      - { flag: R, bind: "18085", target: "127.0.0.1:3080" }
      - { flag: R, bind: "18086", target: "127.0.0.1:3081" }
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就完全静默（连守护都不启动） |
| `user` | 空 | 对端登录名。**空值 = 插件静默不启动** |
| `keyPath` | 空 | 免密私钥路径。**空值或文件不存在时插件静默退出** |
| `sshPort` | `22` | 对端 SSH 端口 |
| `knownHost` | 空 | 优先尝试的对端地址；空则直接进入扫描 |
| `scanSubnet` | 空 | 前缀，扫 `<前缀>.1` – `<前缀>.254`；空则跳过扫描 |
| `scanTimeoutMs` | `900` | 单个地址等待 banner 的时长 |
| `scanConcurrency` | `48` | 扫描并发度 |
| `tickMs` | `20000` | 守护周期（毫秒） |
| `retryCooldownMs` | `8000` | 两次尝试之间的最小间隔，防疯狂重试 |
| `localProbeUrl` | —— | `tunnel_status` 报的探针地址，建议指向某条 `-L` |
| `forwards` | —— | 数组，元素 `{ flag: 'L'\|'R', bind, target }` |

## 前置条件

对端主机需要：

1. 运行 SSH 服务，且**允许你的公钥免密登录**（`BatchMode=yes` 必须能成功 —— 有口令的私钥不行）
2. 放行 SSH 端口的入站连接
3. `-R` 要绑的对端端口可用

⚠️ Windows 上有个容易踩的坑：登录账户若是管理员，公钥要写进
`%ProgramData%\ssh\administrators_authorized_keys`，而且**必须修 ACL**：

```powershell
icacls "$env:ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

不修会被**静默忽略**，表现为「网络通了但 `Permission denied (publickey)`」。

## 安全性

四条硬约束，代码里都做了防护：

1. **`apply()` 绝不抛异常。** 插件加载失败会让整个 profile 起不来，而 DSH 往往是唯一的对话通道。
2. **所有副作用吞掉异常。** 守护失败只记日志，绝不影响 DSH 本身。
3. **私钥只读使用**，不写出、不打印。
4. **只用真实协议判定可达性**（见下），不拿 `connect()` 成功当依据。

### 为什么不拿 TCP connect 当判据

某些环境会**在本地接管所有 TCP 连接**，`connect()` 永远"成功"。
实测：Android 容器里开着 Clash TUN 时，连保留地址 `192.0.2.1:22` 都返回连接成功；
而 `net.connect()` 与 bash 的 `/dev/tcp` 表现一致 —— 也就是说，**这个假阳性与语言无关**。

所以本插件的发现分两步，两步都是真实协议：

1. **读 SSH banner** —— 连上后等对端主动发 `SSH-2.0-…`，收到才算候选
2. **真连一次** —— `ssh -o BatchMode=yes … exit 0`，退出码 0 才算确认

`readSshBanner()` 是导出的，方便单独测试。

## 已知限制

- **对端端口的存在性依赖本机的 SSH 会话。** 本机 DSH 一关，对端那些 `-R` 监听立即消失。
  这是 `ssh -R` 的固有性质，不是插件缺陷 —— 也是「自愈」只在本机运行时才有意义的原因。
- **私钥必须有口令？不行。** `BatchMode=yes` 下无法交互输入，带口令的私钥会直接失败。
- 扫描是一个个候选地真连确认，最坏情况要等若干秒（默认并发 48、单地址 900ms）。
- 平台无关，但默认值偏向「Android 容器 + 局域网 PC」这种场景，移植请改配置。

## Contributors

| 贡献者 | 负责 |
| --- | --- |
| [fssama](https://github.com/fssama) | 需求定义、方案选型、全部设计决策与审阅 |
| DSH agent（`deepseek-flash`，运行于 DeepSeek Harness 容器内） | 实现、测试、文档 |

> **贡献者 ≠ 版权人。** 版权由 LICENSE 中记载的主体持有；本表只如实记录谁做了什么。
> 创作过程的说明见下方 Authoring。

## Authoring

本插件由用户与其设备上的 DSH agent 协作完成：

- **用户**定义需求、选择方案并作出全部设计决策 —— 通道选型（SSH 而非 adb 或开防火墙入站）、
  发现策略（真实协议而非 TCP connect）、守护粒度（20 秒 + 冷却）、
  以及是否开源与许可证选择。
- **agent** 负责实现、测试与文档。

两条关键约束有测试覆盖：`apply()` 绝不抛异常（用「每个方法都抛错的恶意 ctx」验证），
以及 banner 判定必须能区分真实 SSH 与不可达地址（用保留地址 `192.0.2.1` 作对照）。

## License

MIT
