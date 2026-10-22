# 发布手册（RELEASE）

面向维护者的 1.0.0 发布流程。所有命令在**仓库根**（clone 后的目录，下文记作 `<repo>`；
Windows 路径类似 `C:\path\to\dsh-agent-observability`）下执行（Windows + pwsh；bash 写法
在括号里给出）。发布对象只有 `packages/dsh-audit-plugin/` 一个包，根包是 `private: true`。

**发布原则**：先验证后发布，先小范围后公开；出问题优先「发补丁 + deprecate」，不删版本。

---

## 0. 发布前检查单

逐条打勾，任何一条不满足就停下。

- [ ] 两个 `package.json` 的 `version` 都是 `1.0.0`（根包 + `packages/dsh-audit-plugin`）
- [ ] `CHANGELOG.md` 有 `## [1.0.0] - 2026-10-22` 段，内容与本次实际改动一致
- [ ] `packages/dsh-audit-plugin/package.json` 的 `author` 为 `lun`；
      `repository`（含 `directory`）/`homepage`/`bugs` 指向
      `https://github.com/Lun-CC/dsh-agent-observability`，不填占位 URL
- [ ] `files` 白名单覆盖所有随包文件：`lib`、`bin`、`cordis.patch.yml`、`README.md`、
      `README.en.md`、`CHANGELOG.md`、`LICENSE`、`icon`
- [ ] `bin` 字段指向包内 CLI：`"bin": { "dsh-audit": "bin/dsh-audit.mjs" }`
      （**不要写 `./bin/...`**：`npm publish` 会把 `./` 前缀的 bin 判为无效并静默移除，
      本地 `npm pack` 却不会报错，`npm publish --dry-run` 会给出
      `bin[dsh-audit] ... was invalid and removed` 警告）；
      `packages/dsh-audit-plugin/bin/dsh-audit.mjs` 由 `node scripts/sync-core.mjs`
      从根 `bin/dsh-audit.mjs` 派生，**不要手改**
- [ ] 包里含英文 README（`README.en.md`，给 npm tarball 读者；npm 页面只渲染 `README.md`）
- [ ] `engines.node = ^22.19.0 || >=24`、`engines.dsh = >=0.2.0-rc.2`、`dsh.manifestVersion = 1`
- [ ] `LICENSE`（MIT）在仓库根与包内各一份
- [ ] `icon` 可复现：`node scripts/make-icon.mjs` 后 `git diff --exit-code`
- [ ] `node scripts/sync-core.mjs` 后 `git diff --exit-code`（内核 + 派生 CLI 无漂移）
- [ ] `npm test` 全绿（7 个测试文件含 `test/cli-pack.test.mjs`，当前 78 pass）
- [ ] CI（`.github/workflows/ci.yml`）在要发布的 commit 上绿
- [ ] 发布就绪评审的 P0/P1 全部关闭或**明确记录延期理由**（见 `docs/reviews/`）
- [ ] 包名可用：`npm view dsh-audit-plugin version` 返回 404（尚未发布）
- [ ] 本机 `npm whoami` 有权限，npm 账号已开 2FA（发布需要 OTP）
- [ ] 真机安装/卸载验证通过：`docs/evidence/2026-10-22-发布前安装卸载验证.md`
- [ ] 工作区干净：`git status --short` 为空

```pwsh
# 一键跑完静态门禁
git status --short
node scripts/sync-core.mjs; git diff --exit-code
npm test
node scripts/prepare-pack.mjs; node scripts/verify-pack.mjs; node scripts/cleanup-pack.mjs
npm view dsh-audit-plugin version
npm whoami
```

> `verify-pack.mjs` 由 `prepack` 自动调用，也可以单独跑 —— 但它断言包目录里的
> `CHANGELOG.md`（由 `prepare-pack.mjs` 从仓库根临时复制），所以单独跑之前要先
> `node scripts/prepare-pack.mjs`（或直接 `npm pack --dry-run`），跑完用
> `cleanup-pack.mjs` 清掉临时文件。
> 1.0.0 起它断言 `bin/dsh-audit.mjs` 存在且与仓库根 CLI 同步、`README.en.md` 在包内、
> `bin.dsh-audit` 指向正确、CLI 的 import 目标都在包内。若报缺文件，先修 `files` /
> `sync-core`，不要绕过。

---

## 1. 打包（不发布）

在插件包目录执行。`prepack` 会自动做「同步内核 → 复制根 CHANGELOG → 校验清单」，
`postpack` 清理临时文件，所以**必须从包目录跑 `npm pack`**。

```pwsh
cd packages\dsh-audit-plugin
npm pack
# → dsh-audit-plugin-1.0.0.tgz
```

（bash：`cd packages/dsh-audit-plugin && npm pack`）

### 检查 tarball 清单

```pwsh
tar -tzf dsh-audit-plugin-1.0.0.tgz
```

必须能看到（路径都以 `package/` 开头）：

```
package/package.json
package/README.md
package/README.en.md
package/CHANGELOG.md
package/LICENSE
package/cordis.patch.yml
package/icon/                      # 128×128 PNG
package/bin/dsh-audit.mjs          # 离线 CLI（1.0.0 起随包）
package/lib/index.js
package/lib/webui.mjs
package/lib/fixes.mjs
package/lib/core/...               # 同步后的内核
```

一条命令确认 CLI 真的进包了，并核对文件总数：

```pwsh
tar -tzf dsh-audit-plugin-1.0.0.tgz | Select-String 'package/bin/dsh-audit\.mjs'
tar -tzf dsh-audit-plugin-1.0.0.tgz | Select-String 'package/README\.en\.md'
# 1.0.0 应为 17 个文件（含 npm 自动加入的 package.json 与 lib/core/README.md），64.6 kB
# 参考：SHA256 2B17F846…E19CAD、shasum 18096c10…7408（2026-10-22 实测）
(tar -tzf dsh-audit-plugin-1.0.0.tgz | Measure-Object -Line).Lines
```

`files` 白名单：`lib`、`bin`、`cordis.patch.yml`、`README.md`、`README.en.md`、
`CHANGELOG.md`、`LICENSE`、`icon`。

再核对清单里**不该有的东西**：`src/` 测试、`test/`、`.env`、`docs/`、`node_modules`、
`.bak-*`、`*.log`、本机绝对路径。

字段与内容核对：

```pwsh
# 解包到临时目录逐项看
$tmp = Join-Path $env:TEMP "dsh-audit-pack-check"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
mkdir $tmp | Out-Null
tar -xzf dsh-audit-plugin-1.0.0.tgz -C $tmp
Get-Content "$tmp\package\package.json" -Raw
Get-ChildItem "$tmp\package" -Recurse -File | Measure-Object -Property Length -Sum
```

检查 `package.json`：`version=1.0.0`、`engines`、`dsh.bundle.patch`、
`"bin": { "dsh-audit": "bin/dsh-audit.mjs" }`（无 `./` 前缀）、`publishConfig.access=public`、`author`；
确认没有 `"private": true`；`repository` 指向
`https://github.com/Lun-CC/dsh-agent-observability`（插件包带 `directory`）、
`homepage` / `bugs` 指向仓库页面或 issues，**不要出现占位 URL**。

> 离线 CLI 的验证标准：装完后用 profile 的
> `node_modules/.bin/dsh-audit --help`、`--version` 正常（或 `npm exec` 形式），
> `<真实会话> --json` 可跑，且与仓库根
> `node bin/dsh-audit.mjs <同一会话> --json` 的关键字段一致（`id`、`totalReal`、
> `requests`、`toolCalls`、`failedCalls`、`hitRate`、`headline`、`prescriptions`）。

### 用 tarball 做一次隔离安装（发布前最后一道）

**不要**在真实 profile 上试。用独立 `DSH_HOME` 或拷贝 profile：

```pwsh
$env:DSH_HOME = Join-Path $env:TEMP "dsh-audit-release-test"
# 用本机安装的 dsh 命令（桌面版若不在 PATH，可指向其 bin：<你安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js，
# 该虚拟路径只能由桌面版自带的 Node/Electron 加载，普通 node 跑不了，见 docs/evidence/2026-10-22-*）
dsh plugin --profile releasecheck add "file:$PWD\dsh-audit-plugin-1.0.0.tgz"
```

验证：profile 的 `dependencies` 与 `dsh.profile.bundles` 出现 `dsh-audit-plugin`、
`node_modules/dsh-audit-plugin` 存在、`cordis.patch.yml` 条目 id 为 `dsh-cost-audit`、
`node_modules/dsh-audit-plugin/bin/dsh-audit.mjs` 存在；起隔离宿主或 `--dump-config`
确认插件被加载；用真实会话日志确认 `$DSH_HOME/dsh-audit/` 出报告、`/dsh-cost-audit/` 返回 200。

CLI 也在这里验一次（不需要 DSH 启动）：

```pwsh
npm exec --yes --package="$PWD\dsh-audit-plugin-1.0.0.tgz" -- dsh-audit --help
npm exec --yes --package="$PWD\dsh-audit-plugin-1.0.0.tgz" -- dsh-audit --version
npm exec --yes --package="$PWD\dsh-audit-plugin-1.0.0.tgz" -- dsh-audit <真实会话目录> --json
```

详细命令与结论见 `docs/evidence/2026-10-22-发布前安装卸载验证.md`；结果不一致就不要发布。

### 发布时自检（只上传不落库）

```pwsh
npm publish --dry-run
```

确认输出里的文件列表、大小、包名、版本无误。`--dry-run` 仍会跑 `prepack`。

---

## 2. 发布到 npm

```pwsh
cd packages\dsh-audit-plugin
npm publish --access public
```

- `access public` 是首次公开发布的必需项（包内 `publishConfig.access` 已设置，显式写更稳）
- 有 2FA 会提示输入 OTP
- 发布后立刻核对：

```pwsh
npm view dsh-audit-plugin version dist.tarball
npm view dsh-audit-plugin@1.0.0 engines bin
```

`version` 应为 `1.0.0`，`dist.tarball` 指向 `https://registry.npmjs.org/dsh-audit-plugin/-/dsh-audit-plugin-1.0.0.tgz`。

若发布过程中网络中断：先在 npm 网页/`npm view` 确认是否已上传成功；
**不要**为了"重试"而改版本号——同一版本重复 `npm publish` 会报 `EPUBLISHCONFLICT`，
说明已经发布成功。

---

## 3. 从 registry 验证安装（真 profile）

在**真实**的 DSH 上装一次已发布版本（可以先用隔离 `DSH_HOME`，再动真 profile）：

```pwsh
dsh plugin --profile web add dsh-audit-plugin@1.0.0
```

- [ ] Web UI「插件」页出现 `dsh-audit-plugin`，默认启用
- [ ] 右下角出现「¥ 成本报告」按钮，`http://127.0.0.1:<端口>/dsh-cost-audit/` 返回页面
- [ ] 一个新 turn 结束后 `$DSH_HOME/dsh-audit/latest.txt` 有报告、首行带生成时间
- [ ] profile 的 `node_modules/.bin/dsh-audit --help` / `--version` 正常（或 npm exec 形式）；<真实会话> `--json` 的关键字段与仓库根 `node bin/dsh-audit.mjs` 一致
- [ ] `dsh plugin --profile web remove dsh-audit-plugin` 后依赖/bundle 声明/`node_modules` 干净

这一步的结果追加到 `docs/evidence/2026-10-22-发布前安装卸载验证.md`。

---

## 4. 推送仓库、打 tag 与 GitHub Release

仓库已公开：<https://github.com/Lun-CC/dsh-agent-observability>，origin 为
`git@github.com:Lun-CC/dsh-agent-observability.git`。**先确认 npm 发布成功**，再推送与打 tag，
保证 tag 指向与 npm 发布一致的 commit。

```pwsh
git push -u origin main
git tag -a v1.0.0 -m "dsh-audit-plugin 1.0.0"
git push origin v1.0.0
git tag -l v1.0.0          # 本地确认
```

- tag 必须指向与 npm 发布时一致的 commit；**不要移动已推送的 tag**（force-push 覆盖 tag 会
  破坏下游引用；要改版就发 v1.0.1）
- Release notes 直接用 `docs/release/2026-10-22-v1.0.0.md`（面向用户，不写内部实现细节）

创建 GitHub Release（本机没有 `gh` CLI 时用网页：仓库 → Releases → Draft a new release →
选 `v1.0.0` → 粘贴 notes → 附 tarball）：

```pwsh
gh release create v1.0.0 --title "dsh-audit-plugin v1.0.0" `
  --notes-file docs/release/2026-10-22-v1.0.0.md `
  packages/dsh-audit-plugin/dsh-audit-plugin-1.0.0.tgz
```

- 附上 tarball 便于审计/离线安装，但安装仍以 npm 为准
- 若是预发布（rc），用 `--prerelease` 且 npm 发到 `next` dist-tag：`npm publish --tag next`

---

## 5. 回滚策略

### 不推荐 unpublish

`npm unpublish` 会在 72 小时后基本不可用（需联系 npm support），而且**已经装过的用户
不会因为下架而回滚**，反而让 lockfile / 缓存里的版本变成悬空引用。除非包内包含
凭证或恶意代码，否则不要 unpublish。

### 标准回滚：发补丁 + deprecate

1. 在 `main` 上修问题，版本升到 `1.0.1`（语义化：修复用 patch），走一遍本文流程发布。
2. 给有问题的版本打弃用标记：

```pwsh
npm deprecate dsh-audit-plugin@1.0.0 "1.0.0 has a <bug summary>, please upgrade to 1.0.1"
```

`npm install` / `dsh plugin add` 会打印弃用警告；已装用户不受影响，但新装会被提示。

3. 1.0.0 是**首次发布**，registry 里没有更早的版本可以回指；在 1.0.1 发布前 `latest`
   只能是 1.0.0。所以真正的回滚动作是**尽快发 1.0.1 并把 `latest` 指过去**：

```pwsh
npm dist-tag add dsh-audit-plugin@1.0.1 latest
npm dist-tag ls dsh-audit-plugin
```

4. 重新验证：隔离环境 `dsh plugin --profile x add dsh-audit-plugin@1.0.1`，
   跑通报告与页面。

### 文档与仓库侧

- GitHub Release / tag：tag 已推送就**不要** force-push 覆盖；要改版用新 tag（`v1.0.1`）
- Release notes 需要修正时编辑 Release（顶部加「⚠️ 该版本存在 X，已由 1.0.1 修复」），
  不要删除 Release
- 若只是文档错误：直接改 `README*` / release notes 并推送；npm 页面不会自动更新，
  要发 patch 版本重新发布才刷新 npm 上的 README
- npm 页面的仓库链接来自 `repository` 字段，已指向 GitHub；字段变更同样要随 patch 版本发布才生效

### 万不得已：unpublish（仅限 72 小时内 + 安全问题）

```pwsh
npm unpublish dsh-audit-plugin@1.0.0 --force
```

执行后必须马上发修复版并更新文档；同时通知已装用户手动升级。

---

## 6. 发布后收尾

- [ ] `npm view` 与 registry 页面正常，README 渲染正确（英文章节注意相对链接）
- [ ] 本地 tag `v1.0.0` 存在，且 `git ls-remote --tags origin` 可见（已推送）
- [ ] GitHub Release `v1.0.0` 已创建，notes 与 `docs/release/2026-10-22-v1.0.0.md` 一致
- [ ] `npx --yes --package=dsh-audit-plugin dsh-audit --help` 在干净环境可跑（CLI 入包生效）
- [ ] 更新 `CHANGELOG.md` 的版本落款（若发布流程改动了内容）
- [ ] 在 `docs/reviews/` 或 issue 里记录本次发布结论与遗留项
- [ ] 观察首日安装反馈；`errors.log` 类问题优先修，不等下个版本
