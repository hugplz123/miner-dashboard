# 矿箱负荷看板

当前版本覆盖除 Koye01 外的 5 个场地，默认展示最新可用一天，并保留最近 7 天趋势。
当天数据不足 24 小时时不会补齐或伪造缺失小时，页面会明确标注实际覆盖范围。

| 场地 | data_center_id |
| --- | --- |
| Blossom01 | `c0449798c6494a49bac60a6d924c9115` |
| May01 | `abca092860704393bcf1070462510797` |
| Nimrod01 | `1c675cf08cea473393c3cfa01976b065` |
| Nimrod02 | `2da96783a4bf449a90f81d4d9c5fc884` |
| WhiteOak01 | `435d3ecd71a34488a17c5f788a0f25ca` |

当前样本日期为 `2026-11-04` 至 `2026-11-10`，共 13,353 个矿箱小时。
最新一天的 90 个矿箱保留算力组、型号、档位和单机下钻，共 2,845,842 条单机小时记录。
完整 `dashboard/` 约 89.4 MB，其中七日明细经 gzip 压缩后约 76.9 MB。

每个矿箱每天的明细拆成两个文件：约 14 KB 的 `summary.json.gz` 包含算力组、型号和档位，
约 118 KB 的 `machines.json.gz` 包含单机明细。打开矿箱时只读取汇总包，切换到“矿机”
页签或使用峰值矿机功能时才读取单机包，避免首屏下载当天全部机器记录。

## 本地预览

```powershell
python -m http.server 8765 --bind 127.0.0.1 --directory dashboard
```

打开 `http://127.0.0.1:8765/`。这个地址只适用于本机或屏幕共享；
其他同事访问需要把 `dashboard/` 发布到静态托管。

## 每日更新

推荐直接双击根目录的 `update-dashboard.cmd`。它会依次完成：

1. 从 Lark 多维表格刷新矿箱容量快照；
2. 从数据库查询昨天，并复用本地仍保留的前 6 天；
3. 重建近 7 天静态数据并做一致性校验；
4. 提交 `dashboard/` 的更新并推送到 GitHub；
5. 由 GitHub Pages 自动发布，通常一两分钟后线上生效。

也可以在 PowerShell 中运行：

```powershell
.\update-dashboard.ps1
```

只更新本地、不提交和推送：

```powershell
.\update-dashboard.ps1 -NoPublish
```

跳过数据校验：

```powershell
.\update-dashboard.ps1 -SkipVerify
```

如果当天数据第一次生成时还不完整，只重新查询并覆盖最新一天：

```powershell
.\update-dashboard.ps1 -Refresh
```

如果要把滚动 7 天内缺少的单机明细一次性补出来（会重新查询这些日期，耗时更长）：

```powershell
.\update-dashboard.ps1 -BackfillDetails
```

回填只处理还缺明细的日期；已经有完整明细的日期会直接复用。完成后，这些历史日期
也能下钻到矿机，并按单机功耗上限筛选。

脚本默认保留 7 天，只查询缺失的最新一天。已经发布或已在本地的历史 6 天不会重复查库，
因此每日运行时间不是七日全量查询的 7 倍。重新汇总本地缓存约需 1 至 2 分钟，
数据库查询时间取决于 VPN、连接速度和当天数据量。

Lark 同步使用本机已授权的 `miner-dashboard` bot profile。只读容量表，不向页面导出
凭证、`SourceID` 或 IP 范围。可以单独刷新快照：

```powershell
python sync_lark_power.py
```

如果临时拉取失败但本地已有 `dashboard/data/lark_power.json`，每日更新会保留旧快照并
继续更新数据库数据，页面顶部会显示该快照的实际同步时间。首次运行且本地没有快照时
会直接停止，避免发布一份没有容量数据却看似正常的看板。

小时数据尚未到齐时仍可发布，页面和验证器会按实际已有小时统计，不会因为不足
24 小时而失败。日期下拉、顶部状态、矿箱卡片和趋势图都会标注覆盖情况。

本地更新不要求公网 IP。运行更新的电脑只要能访问数据库并连接 GitHub 即可。
GitHub 收到新的 `dashboard/` 提交后会自动重新发布静态页面，浏览器不会连接数据库。

首次生成或需要重建某一天时：

```powershell
python sample_export.py --date 20261101 --all-sites --output-dir outputs/detail-cache/20261101
python build_dashboard.py --days 7 --end-date 20261101 --detail-date 20261101
```

只用已有源缓存重新聚合，不重新连库：

```powershell
python sample_export.py --date 20261101 --all-sites --reuse --output-dir outputs/detail-cache/20261101
python build_dashboard.py --days 7 --end-date 20261101 --detail-date 20261101
```

数据库连接复用相邻项目 `..\功耗数据更新\config.toml` 的只读配置，不在本仓库保存密码。

## 发布方式

推荐先生成静态文件，再发布到 GitHub Pages。页面和 JSON 都是静态资源，
浏览器不会直连数据库，也不会暴露数据库账号。

仓库内已准备：

- `.github/workflows/pages.yml`：推送 `dashboard/**` 后发布页面。
- `.github/workflows/rolling.yml`：供能访问内网数据库的 Self-hosted Runner 手动刷新；
  GitHub 托管 Runner 无法连入本机 VPN，因此未启用云端定时触发。
- `run_rolling.py`：恢复仍在线的前 6 天，只导出缺失的最新一天。
- `update-dashboard.ps1`：本机手动执行同一套滚动更新。

首次发布需要在 GitHub 仓库的 `Settings > Pages > Source` 选择 `GitHub Actions`，
并配置 Actions Secrets：

| Secret | 内容 |
| --- | --- |
| `DB_HOST` | 数据库主机 |
| `DB_PORT` | 数据库端口 |
| `DB_USER` | 只读账号 |
| `DB_PASSWORD` | 只读密码 |

如果数据库只允许固定 IP，GitHub 托管 Runner 会因出口 IP 变化而无法连接。
这种情况下应把手动任务或 GitHub Self-hosted Runner 放在能访问数据库的内网服务器，
生成静态文件后再同步到 Pages 或普通 Web 服务器。

当前每日更新使用本机 `update-dashboard.cmd`，云端只负责发布已经提交到
`dashboard/` 的静态文件。这样不会因为 GitHub Runner 连不上数据库而每天产生失败邮件。

GitHub Pages 适合每日复盘。它不是实时功率看板：页面展示的是最近一次成功导出的小时数据。
如果会议或填负荷必须看当前小时，需要提高导出频率，或单独建设带鉴权的数据库 API。

## 计算口径

每行代表一个矿箱的一个小时。先按 `场地ID + hour + IP` 去重单机记录，
解析 `worker_location` 数组，将每个元素按第一个 `-` 前的矿箱 ID 关联
`t_data_center_ware_house`，再计算矿箱指标。

| 指标 | 计算方式 |
| --- | --- |
| 矿机数量 | 本矿箱本小时去重 IP 数 |
| 实际功率(kW) | `SUM(avg_power) / 1000` |
| 理论功率(kW) | 外部理论功率表按场地名和标准化矿箱号匹配 |
| Lark 在架功率(kW) | 多维表格容量快照，按场地名和标准化矿箱号匹配 |
| Lark 占位功率(kW) | 多维表格中的已占位容量快照 |
| 单机理论平均功率(kW) | 多维表格中的单机理论平均功率 |
| Lark 功率差额(kW) | `Lark 功率 - 理论功率`，正数表示高于理论功率 |
| 负载率 | `实际功率 / 理论功率` |
| 容量差额(kW) | `理论功率 - 实际功率`，保留负值 |
| 可填负荷(kW) | `MAX(容量差额, 0)`，未扣安全裕度和供电约束 |
| 算力组 | `client_miner_template_id` 关联 `t_client_miner_template.id/name` |
| 型号 / 档位 | 按单机记录的 `model` / `work_mode` 分组计数 |
| 平均算力(TH/s) | 去重记录的 `AVG(avg_hashrate) / 10^12` |
| 单机功耗比(W/TH) | `avg_power / (avg_hashrate / 10^12)` |
| 整体功耗比(W/TH) | 可计算样本的 `SUM(avg_power) / SUM(avg_hashrate / 10^12)` |
| 功耗比有效样本 | 算力和功耗均大于 0 的记录数 |
| 拒绝率 | 最大、最小、平均；平均为单机等权平均 |
| 温度 | 源值按华氏度处理，再转换为摄氏度 |
| 场地小时覆盖 | 当日 24 个业务小时中，该场地至少有一个矿箱记录的小时数；不等同于所有矿箱完整 |
| 矿箱小时覆盖 | 当日 24 个业务小时中，该矿箱自身有记录的小时数 |
| 数据完整性 | 场地 24 小时齐全且所有矿箱都有 24 小时记录；缺失小时不补齐 |

Lark 矿箱编号使用 `1`、`2`，数据库使用 `C01`、`C02`。匹配时去掉可选的 `C` 前缀、
前导零后转为整数，再与场地名一起组成键。当前快照有 96 条记录：Blossom01 10 条、
May01 12 条、Nimrod01 18 条、Nimrod02 16 条、WhiteOak01 40 条。矿箱名称只在场地内
唯一：Nimrod01 和 Nimrod02 都有名为 C17、C18 的仓库定义，但 ID 不同。页面按“场地 ID
+ 小时 + 仓库 ID”识别矿箱，并且只展示所选日期实际有小时数据的定义。Nimrod02 的
C17、C18 没有数据，因此不进入页面和统计，Nimrod02 显示为 16/16；Nimrod01 的
C17、C18 有数据时仍正常显示，Nimrod01 为 18/18。

另有 4 箱在 Lark 中匹配成功但容量字段为空，页面显示“字段缺失”和 `—`，不会把缺失值
当成 0。

`worker_location` 同一小时可能出现多个值。解析后同一矿箱的位置会去重；
如果出现多个不同矿箱或无法匹配，记录异常，不把同一台矿机重复计入不同矿箱。
重复 `场地ID + hour + IP` 时优先保留 `gmt_modified` 最新的记录，
再按 `gmt_create`、`id` 降序确定。

温度字段中 `0` 表示部分场地没有有效采集。Blossom01 最新一天的 57,600 条记录、
May01 的 57,432 条记录都是 `0`，如果直接按 `0°F` 转换会得到 `-17.8°C`，
所以导出时将 `temperature <= 0` 视为缺失，不对无样本矿箱生成虚假温度。

跨小时相加得到的是矿机小时记录数，不是全天独立物理矿机数。
跨小时平均是记录加权平均，不应当作全天能耗统计。

`catalog.json` 的每日汇总保存 `hours_with_data`、`expected_hours`、
`is_complete`、`is_fully_complete`、`incomplete_warehouse_count` 和
`warehouse_hour_counts`。每个场地的 `warehouse_hours_by_date` 保存各矿箱
实际出现的业务小时，页面用它区分场地覆盖和单箱覆盖。趋势图中不完整日期带
`*`，表示该日不能直接视为完整的 24 小时样本。

## 验证

```powershell
node verify_dashboard.cjs
```

验证器会检查七日汇总、实际小时覆盖和矿箱覆盖、各层台数、功耗比可计算样本、
温度缺失标记、Lark 公开字段与匹配数量、压缩明细、汇总包/单机包按需加载、当日峰值
下钻、历史日期明细、覆盖率标注、场地和日期切换、趋势图以及手机布局。
