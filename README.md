# 客户异议应答助手

给客户经理用的内部工具。客户经理填入客户原话和已知的产品信息，说明要给哪类客户写话术，系统输出带依据的应答话术（高净值客户版、普通理财客户版），以及追问应对、需要向客户确认的信息和待核实事项。客户不接触系统，话术由客户经理审核后使用。

## 工作方式

```
应答 agent（加载应答 skill）
   拆解客户的话 → 查产品事实卡 → 读类型指引和客群指引
   → 到规则库读本次适用的规定原文并核对引用（动笔之前）
   → 核对数字、计算差值 → 按客户类型写话术 → 提交产出
        ↓
检查 agent（加载检查 skill）
   对照案例材料和规则原文，用工具重新核对数字和引用，
   逐句检查合规红线、相对业绩的用法、赎回问题的处理、两版话术的区别 → 提交问题清单
        ↓  有"必须修改"的问题 → 带着修改意见交回应答 agent（最多返工 2 轮）
客户经理审核后使用
```

- **判断全部交给 agent**。代码只做模型不擅长的精确操作，以工具形式提供：原文查找、精确计算、比较、规则库检索。代码里不写业务规则。
- **重点在知识**。两份 skill 是 `skills/objection-reply/SKILL.md` 和 `skills/objection-review/SKILL.md`；知识在 `knowledge/`：易错点说明书、合规口径、产出格式、异议类型指引、客群指引、规则库导航、产品事实卡。
- **规则库**：证监会、基金业协会官网发布的 9 份规则原件（公募基金销售机构办法、宣传推介规定、适当性细则、销售费用规定等），按业务日期提供，晚于业务日期发布的不能用。agent 检索和阅读由原件转换的 Markdown，引用在原件文字中逐字核对。
- **原文角标**：话术里引用案例材料和法规原文的地方显示角标 [1][2]。角标里的文字由系统拿模型的引文到原文中定位后逐字取出；点开案例材料的角标在左栏高亮，点开法规的角标显示原件那一页；找不到的标红。
- **运行记录**：结果页可以下载运行记录（Markdown），包含输入、两个 agent 的每一步和工具调用、每一轮检查发现的问题、每一轮的产出。
- **模型**：DeepSeek，使用 OpenAI 兼容接口，默认模型为 `deepseek-flash`。
- **部署**：Cloudflare Pages。Pages 提供前端静态文件（`dist/`），`functions/api/` 提供接口（`/api/*`）。

## 目录

| 路径 | 内容 |
|---|---|
| `skills/` | 应答 skill、检查 skill |
| `knowledge/` | 易错点说明书、合规口径、产出格式、类型指引（`types/`）、客群指引（`segments/`）、规则库导航、产品事实卡（`data/products.json`） |
| `public/kb/rules/` | 规则库：原件（`files/`）、索引、按页文字（核对引用用）、Markdown（`md/`）、分段和分段向量 |
| `src/core/` | agent 引擎（工具循环、返工控制）、工具、结构校验、提示词拼接、流式解析 |
| `src/server/` | `/api/agent` 的处理逻辑：口令、限流、拼接系统提示词、转发 DeepSeek |
| `functions/api/` | Cloudflare Pages 的接口入口 |
| `src/app/` | 界面：案例填写、过程记录、结果与依据、导出、验证页（`#/eval`） |
| `tests/` | 单元测试：工具、引擎（模拟模型）、服务端、规则库 |
| `scripts/` | 打包知识、打包 skill、建规则库、本地模拟后端 |

## 本地开发

需要 Node 22.18 或更高版本。

```bash
npm install
npm test            # 单元测试，不需要模型密钥
npm run build
```

**只看界面、不调用模型**：用模拟后端，返回的是手写的预设回复，不是模型的输出。

```bash
npm run build && node scripts/mock-server.mjs 4173
# 打开 http://localhost:4173
```

**修改知识后**：改了 `skills/` 或 `knowledge/` 下的文件，运行 `npm run knowledge` 重新生成 `src/shared/knowledge.generated.ts`。构建时也会自动生成。

## 部署到 Cloudflare Pages

1. Cloudflare 控制台 → Workers & Pages → Create → Pages → Import an existing Git repository，选本仓库。
2. 构建设置：Framework preset 选 None；Build command 填 `npm run build`；Build output directory 填 `dist`；环境变量加一条 `NODE_VERSION` = `22`。
3. 项目的 Settings → Variables and Secrets 里添加密钥（类型选 Secret）：`DEEPSEEK_API_KEY`；可选 `ACCESS_CODE`（体验口令）。
4. Settings → Bindings → Add → Workers AI，变量名填 `AI`（检索时把问题转成向量；不加也能用，只是退回关键词检索）。
5. 保存后重新部署。之后每次推送到 main 分支，都会自动部署。

可选的普通变量：`DEEPSEEK_MODEL`（默认 `deepseek-flash`）、`OPS_THINKING` / `REVIEW_THINKING`（`enabled` 或 `disabled`）、`OPS_EFFORT` / `REVIEW_EFFORT`（`low` / `high` / `max`）、`MAX_TOKENS`、`RATE_LIMIT_PER_10MIN`。

## 在 Claude Code 中试用 skill

```bash
npm run skills:package   # 输出到 dist-skills/
```

把 `dist-skills/objection-reply` 和 `dist-skills/objection-review` 复制到 `.claude/skills/`，然后在一个全新的会话里试用。

## 如实说明

- **预置数据**：产品事实卡按题目给出的信息预置，题目没给的字段标为"未提供"。示例案例和示例要求是预先填好的文字，处理过程是实时调用模型的。
- **规则库的范围**：只收录了公募基金销售、宣传推介和适当性管理相关的 9 份现行文件。资管新规、证券期货投资者适当性管理办法、银行理财产品销售的规定尚未收录；产品的监管类别未说明时，系统会把"适用哪套规定"列为待核实。
- **角标**：角标只证明"这段文字确实在原件里"，不证明引文支撑了结论；引文是否恰当由检查 agent 判断，客户经理审核时仍需看原文。
- **知识覆盖范围**：类型指引只写了"业绩回撤与赎回"和一份通用指引；客群指引只有高净值客户和普通理财客户两份。
- **没有接入真实系统**：没有接入产品库、客户信息、风险测评等系统，也没有真实的客户数据。
- **口令和限流**：没有登录功能，只有可选的体验口令；限流只在单个运行实例内有效。
- **测试范围**：单元测试覆盖工具、引擎流程、服务端逻辑和规则库。模型实际输出的质量通过验证页（`#/eval`）测试。`scripts/mock-server.mjs` 只用于本地检查界面，不会部署。
- **沿用的部分**：agent 引擎、工具和界面框架沿用自本人此前的另一个项目，skill、知识和界面流程为本题重写。
