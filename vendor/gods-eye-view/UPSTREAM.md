# gods-eye-view 上游快照

- 上游 commit：43a67f9ae224e7a1d6d32d81f690520f5c7f7f70
- 导入日期：2026-11-02
- 上游地址：https://github.com/bilawalsidhu/gods-eye-view

本目录是 [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)（下称 GEV）某个
commit 的**源码快照**，由 `pnpm globe:vendor <commit-sha>`（脚本
`infra/scripts/src/globe-vendor.mts`）同步生成。不要手工编辑这里的文件；升级时先在分支上
重跑脚本，再把下表登记的本地补丁逐个重新打上。

不考虑 `git subtree`：它会把约 120 MB 的上游历史带进本仓库。

## 排除清单

导入时按下列规则排除（见 `infra/scripts/src/globe-vendor.mts`）：

- `docs/media/`（上游演示媒体，体积大且非构建所需）
- `.github/`
- `.agents/`
- `node_modules/`
- `.env*`（但保留 `.env.example`）

## 本地补丁

| 文件 | 目的 | 摘要 | 批次 |
| --- | --- | --- | --- |
| _（本批为空）_ | | | |

## 许可说明

- **代码**：MIT，见同目录 `LICENSE`。
- **数据和模型**：分别遵循 `LICENSE`、`DATA_SOURCES.md`、`public/models/README.md` 中
  各自声明的许可。
- **非商用数据清单**（转商用前必须移除或替换）：
  - 海缆（submarine cables）：CC BY-NC-SA
  - Bhote Koshi 洪水场景：CC BY-NC
  - OpenSky：非商用研究许可
  - 摄像头：FL511 仅限个人使用；NYC 需签协议，默认不开
