# dsh-nix-dev-shell

让 DeepSeek Harness 的 bash 命令自动进入工作区的 **Nix 开发环境**：只要命令的工作目录（或其任一上级目录）里存在 flake.nix，就用 `nix develop` 提供的 devShell 环境，而不是宿主的原生 bash 环境。

## 它怎么工作

`dsh-bash-*` 执行器把命令统一收敛到 shell 能力 seam `ctx.shell`（参考文档：<https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/shell>）。本插件**不替换**执行器，而是修饰 `ctx.shell` 实例上的 `execute` 方法：

1. 根据 `spec.workdir` 逐级向上查找 flake.nix（类似 direnv 的祖先查找）。
2. 命中后取得该 flake 的 devShell 环境：
   - `env` 模式（默认）：一次性运行
     `nix print-dev-env`（会一并执行 shellHook），把结果与当前进程环境做差集，缓存后注入到每次 spawned 进程的 `env`。因此每条命令 **没有** nix 启动开销，也不会把 shellHook 的输出混进工具结果。
   - `wrap` 模式：把命令改写成 `nix develop <flakeDir> --command bash -c '<command>'`，语义与手工执行 `nix develop` 完全一致，但每条命令多一次 nix 求值（约 0.3–1s），且 shellHook 的输出会出现在结果里。
3. 未命中 flake.nix、nix 不存在、`nix print-dev-env` 失败或任何内部异常时，**原样退回原生 bash**，并在日志里告警。

因为始终调用原执行器，以下能力完全不受影响：

- 文件沙箱（workspace-write / read-only / danger-full-access）与提权审批；
- 超时、`onExpiry`、abort 取消、输出截断与 spill 文件；
- 后台任务（`ctx.jobs`）与 `run_in_background`；
- `DSH_*` 受管环境变量（由 `ctx.shellEnv` 收集，最后合并，优先级最高）。

捕获 devShell 环境时通过**未修饰的原执行器**运行 helper，因此 helper 使用与命令相同的沙箱策略，不额外获得权限。

## 安装

```sh
dsh plugin --profile web add github:running-grass/dsh-nix-dev-shell
```

Host 插件是 JS 模块，安装/更新后需要重启 DSH 进程才会加载新代码。

### 从本地目录安装（开发时等价方式）

在会话中让 Agent 调用 `plugin_manager`：

```json
{ "action": "install_bundle", "target": "/abs/path/to/dsh-nix-dev-shell" }
```

安装后确认 `nix-dev-shell` 行已激活：`plugin_manager list_plugins` 中应出现
`include:nix-dev-shell` 且 `fiberPhase=active`；行为验证见下方「验证」。

## 验证

装好后在工作区（含 flake.nix 的目录或其子目录）执行任意命令，应能看到：

```sh
echo $IN_NIX_SHELL      # impure
command -v ocaml dune   # /nix/store/…（宿主机上没有它们）
echo $NIX_CACHE_HOME    # 沙箱可写的 nix 缓存目录
```

不跑 nix 的目录（例如 `$HOME`）应保持原生环境，插件不会注入任何东西。

## 配置

行内 `config`（`cordis.patch.yml` 已给出默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。 |
| `mode` | `'env'` | `'env'` 注入环境 / `'wrap'` 走 `nix develop --command`。 |
| `flakeFile` | `'flake.nix'` | 向上查找的文件名。 |
| `maxAncestors` | `40` | 最多向上查找的目录层数。 |
| `captureTimeoutMs` | `30000` | 单次环境捕获的超时。 |
| `retryMs` | `60000` | 捕获失败后的重试间隔。 |
| `ttlMs` | `600000` | 捕获结果的最长复用时间。 |
| `cacheDir` | `'.dsh-plugins/.cache/nix'`（随行配置；代码内默认为 `''` = 临时目录） | 沙箱内 nix 的缓存目录（`NIX_CACHE_HOME`，helper 里同时设 `XDG_CACHE_HOME`）；相对路径按 **flake 根目录**解析（不是 Harness 进程的 cwd）。 |
| `injectCacheHome` | `true` | 在 flake 工作区内、且命令受沙箱约束时，把 `NIX_CACHE_HOME` 注入命令环境，使显式 `nix` 命令开箱可用。 |
| `nixCommand` | `'nix'` | nix 可执行文件的名称或绝对路径。 |
| `promptContext` | `true` | 向模型注入一条运行时上下文，说明 devShell 已生效、来源于本插件（而非 direnv）。 |

### 缓存与失效

每个 flake 目录的戳记由 `flake.nix`、`flake.lock` 与目录三层以内所有 `*.nix`（有界扫描，最多 256 项）的 mtime + size 组成：拆到 `nix/*.nix` 的 devShell 模块改动也能立即刷新，其余情况由 `ttlMs` 兜底。失败结果在 `retryMs` 内负缓存，避免每条命令都付出失败代价。

刷新失败时**优先复用上一次捕获成功的环境**（flake 正在改动、网络抖动等临时故障不会把命令悄悄降级成原生 bash），只有从未成功捕获过才回退到原生 shell。

### 环境注入范围

注入的是 devShell 相对当前进程**变化或新增**的变量（与 `process.env` 做差集），并额外屏蔽：

- shell/交互状态：`PWD`、`OLDPWD`、`SHLVL`、`_`、`SHELL`、`PS1/PS2/PS4`、`BASH_ENV`、`BASHOPTS`、`SHELLOPTS`、`IFS`、`OPTERR`、`LINENO`、`RANDOM`/`SECONDS`/`EPOCH*`；
- Harness 的终端策略：`TERM`、`NO_COLOR`、`PAGER`、`GIT_PAGER`（保持执行器的 `TERM=dumb` 等设定）；
- Nix 构建期临时路径：`TMP`、`TMPDIR`、`TEMP`、`TEMPDIR`、`NIX_BUILD_TOP`、`XDG_CACHE_HOME`、`NIX_CACHE_HOME`、`shellHook`；
- Harness 受管命名空间：`DSH_*`、`npm_*`。

`stdenv` 的其余变量（`PATH`、`CC`/`CXX`/`AR`、`NIX_CFLAGS_COMPILE`、`NIX_LDFLAGS`、`CAML_LD_LIBRARY_PATH`、`OCAMLPATH`、`OCAMLFIND_DESTDIR`、`XDG_DATA_DIRS`、`buildInputs`、`buildPhase`、`out` 等）保留，行为与手工 `nix develop` 一致。

### 沙箱里的 nix 缓存（`NIX_CACHE_HOME`）

`workspace-write` 沙箱会把 `~/.cache` 设为只读，于是直接执行 `nix develop` / `nix build` / `nix flake update` 会失败：

```
error: … unable to open database file (in '~/.cache/nix/fetcher-cache-v4.sqlite')
```

插件因此在 flake 工作区内自动注入 `NIX_CACHE_HOME`（只在受沙箱约束时；`danger-full-access` 下不注入）：

- 只影响 nix，不会像 `XDG_CACHE_HOME` 那样顺带改变其它工具（cargo/clangd 等）的缓存位置；
- 缓存目录由 `cacheDir` 决定；本 profile 的 bundle patch 设为 `.dsh-plugins/.cache/nix`（相对 flake 根目录，即本仓库根），跨工具调用复用；
- 不需要时设 `injectCacheHome: false`，手动在命令前加 `NIX_CACHE_HOME=/some/writable/dir`。
- `/tmp` **不能**用来做跨调用缓存：Harness 的每条 bash 命令都跑在独立沙箱里，`/tmp` 是每次新建的 tmpfs（实测相邻两次调用 `/tmp` 设备号 82 → 72，写入的文件下次即消失）。因此 `/tmp/dsh-nix-shell/<sessionId>` 之类的方案每条命令仍是冷缓存；唯一能跨调用持久化的可写位置是工作区（bind mount）。

### 冷缓存 vs 热缓存的实测开销

本机测 `nix develop --command true`（Nix 2.34.9，flake 输入已在 store 中；同一进程内交替测量以抵消文件系统缓存偏差）：

| 缓存位置 | 每条 nix 命令耗时 | 说明 |
| --- | --- | --- |
| `NIX_CACHE_HOME` 指向全新临时目录（每次工具调用都重建） | **~540 ms** | 冷缓存：需重建 2.3 MB 的 eval/fetcher sqlite 缓存 |
| `NIX_CACHE_HOME` 指向工作区内持久目录（第二次及以后） | **~125 ms** | 热缓存；`nix --version` 的启动基线约 18 ms |

即：持久化缓存每条 nix 命令省 **约 0.4 秒**（4 倍以上），代价是工作区内约 2.3 MB 的缓存目录。注意：

- 这个差值只作用于**真正调用 nix 的命令**；不跑 nix 的命令不受影响（插件只多几次 `stat`，可忽略）；
- 缓存目录若在仓库内，需加入 `.gitignore`（本仓库的 `.dsh-plugins/` 已通过 `.git/info/exclude` 忽略）；
- `nix build`/`nix flake update` 等需要下载或求值更多的命令，冷缓存的劣势通常比上表更明显。

## 模型如何知道它在生效

模型默认看不到「谁改了环境」——它可能把 `IN_NIX_SHELL=impure` 和 /nix/store 的工具链归功于 direnv，或干脆以为还是原生环境。这正是本插件向**运行时上下文**（`ctx.systemPrompt.context`，与 working-directory、sandbox-policy 报告运行事实的是同一个注册表）贡献一句话的原因：

> Bash commands run inside the Nix dev shell of `<flakeDir>` (dsh-nix-dev-shell plugin, not direnv): IN_NIX_SHELL=impure, the toolchain comes from /nix/store, NIX_CACHE_HOME is writable, and `nix` works directly.

行为细节：

- **条件式**：只有该会话的 cwd 能找到 flake、且本插件已成功捕获过它的 devShell 时才会出现；捕获失败、目录不在 flake 内、无 agent 的 assembly 一律返回空串（空串会被提示词装配过滤掉，不占 token）。
- **一步延迟**：捕获发生在第一次 bash 调用里，因此这句话从**下一次**模型请求开始出现；不额外增加提示词装配的延迟（不在 assembly 里跑 nix）。
- **不改内置 tool 描述**：`bash` 的 schema 由 `dsh-tool-bash` 拥有，外部插件没有稳定的改写缝；`ctx.systemPrompt.context` 才是这类运行时事实的公开扩展点（`dsh-tool-bash` 自己也是用 `systemPrompt.section` 加 `[exit code: N]` 提示的）。
- 关闭：`promptContext: false`。

## 安全边界

- 祖先查找意味着：`$HOME` 或任意上层目录若有 `flake.nix`，其 devShell 会作用于该子树下的**每条** bash 命令；克隆来的第三方仓库首次命令即会执行其 `shellHook`。这是 direnv 式行为的固有代价，请只在可信仓库启用（或把 `enabled` 设为 `false` / 调小 `maxAncestors`）。
- 捕获 helper 通过**未装饰的原执行器**运行，沿用调用方的沙箱策略：`workspace-write` 下仍是同一个 bwrap 沙箱（`/` 只读、仅工作区可写），不会因插件而提权；`danger-full-access` 下才是无约束运行。
- `env` 模式的捕获成本每条 flake 一次（约 0.3–1s，`captureTimeoutMs` 上限内），之后每条命令只多约 20ms；`wrap` 模式每条命令都要付出一次 nix 启动。

## 已知边界

- 只覆盖 `ctx.shell`（bash 工具、子代理、hooks 桥接、后台任务）；PTY 终端子系统（`ctx.terminal`）与 tmux 会话不在其中。
- `wrap` 模式在 `workspace-write` 沙箱下需要把 nix 缓存目录指到可写位置（插件通过 `NIX_CACHE_HOME` 自动处理），否则 nix 无法打开 fetcher cache；`env` 模式的捕获与显式 `nix` 命令同样依赖它。
- `env` 模式传递的是环境而非交互式 shell 状态：函数、别名、`set -x` 等不会传递；`shellHook` 中的 `export` 会被捕获。
- 与任何"替换执行器"的插件不兼容：那种插件若在 `ctx.shell` 上重新注册服务，会覆盖本装饰器。
- 宿主 `SHELL` 被保留（不随 devShell 变成 nix bash）；插件本身始终显式调用 `bash`。

## 自测

```bash
node test/selftest.mjs
```

离线运行：用假执行器驱动装饰器，不调用 nix、不接触真实 Harness，覆盖 env 注入/差集/deny 列表、`NIX_CACHE_HOME` 注入与沙箱条件、缓存与单飞、负缓存、stale-env 回退、拆分 `nix/*.nix` 的缓存失效、`wrap` 模式的 argv 精确转义、卸载恢复与异常输入。

## 卸载

```json
{ "action": "remove_bundle", "target": "dsh-nix-dev-shell" }
```

卸载会通过 `ctx.effect` 的清理函数删除实例上的装饰，`ctx.shell.execute` 恢复原执行器方法（自测已覆盖）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
