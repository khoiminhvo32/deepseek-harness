# Thiết kế: `dsh-hard` — Hard Harness cho vulnerability research liên tục

- **Ngày:** 2026-10-04
- **Trạng thái:** PROPOSAL — chờ duyệt trước khi implement
- **Base:** deepseek-harness `master` (0.2.1-alpha.1)
- **Phạm vi:** bundle plugin mới + profile mới. Không sửa `packages/core/agent-loop`.

---

## 1. Mục tiêu

Biến `dsh` thành một harness ép model hunt bug trong một codebase mục tiêu **liên tục và không bỏ cuộc**:

1. **Không tự tuyên bố "hết bug"** — chỉ harness được quyền kết luận xong việc, dựa trên bằng chứng tích lũy (coverage + verification), không dựa trên lời model.
2. **Không chấp nhận hallucination** — một bug chỉ được tính khi có PoC chạy được do **harness tự thực thi**, impact xác minh được từ observable effect, và điểm CVSS **tính lại đúng từ vector** bằng code deterministic.
3. **Sống qua giới hạn** — chạm quota/rate limit thì standby, tự thức dậy đúng giờ reset và làm tiếp; hết context thì compaction + handoff state có cấu trúc rồi làm tiếp. Session bền qua restart (sẵn có của repo).
4. **Methodology hai pha** — Phase A: source–sink sweep cho các lớp lỗi có pattern rõ (SQLi, XSS, CMDi, path traversal, deserialization, SSRF, authz, crypto misuse, race…). Phase B: **deep-read sáng tạo** — bắt model đọc hiểu luồng code, vẽ dataflow/trust boundary/state machine, đặt hypothesis kể cả những lớp lỗi mà source–sink không bắt được (logic flaw, design flaw, exploit chain), rồi chứng minh hoặc bác bỏ từng hypothesis.

## 2. Non-goals

- Không phải fuzzer, không scan đa mục tiêu: một session = một target repo tại một commit pin.
- Không exploit từ xa: PoC chỉ chạy local, trong sandbox provider, mặc định chặn mạng.
- Không sửa agent-loop (Phase 2 optional liệt kê ở §11 nếu sau này cần语义 cứng hơn).

## 3. Nguyên tắc thiết kế (bám AGENTS.md)

1. **Harness owns completion.** Model chỉ được *đề xuất* xong; quyền kết luận thuộc verifier + stopgate.
2. **Verification-driven, không pressure-driven.** "Ép lì lợm" không phải là hét to hơn mà là *chỉ chấp nhận bằng chứng kiểm chứng được*. Áp lực thuần túy khiến model bịa bug cho có — điều kiện 2 của mục tiêu tồn tại để chặn đúng việc đó.
3. **Model-visible ⟺ logged.** Mọi prompt, steering, state bơm cho model phải tái tạo được từ session log. Ledger/findings là typed session events.
4. **Plugins, not loop changes.** Mọi hành vi mới đi qua extension points đã tài liệu hóa.
5. **No hardcoded tunables.** Mọi ngưỡng (số vòng, số lần chạy PoC, timeout, giờ reset quota…) là `Config` field đổi được từ `cordis.yml`.
6. **Misconfiguration fails loud** lúc load (thiếu target, bugClasses rỗng, cron sai…).
7. **Sandbox-only PoC execution.** Verifier chạy PoC qua shell seam với sandbox provider `strict`; egress mạng mặc định deny lúc chạy PoC (cho phép mạng riêng ở phase build dependencies, qua config).

## 4. Kiến trúc tổng thể

```
dsh --profile hard
└── profile "hard" = dsh-base + bundle dsh-hard        (compose bằng cordis.yml, không fork)
    ├── dsh-hard-mission     arm goal + mission contract trong system prompt
    ├── dsh-hard-ledger      typed session events + LedgerService (findings/hypotheses/coverage)
    ├── dsh-hard-tools       model-facing tools (submit_finding, hypothesis_*, mark_coverage…)
    ├── dsh-hard-verifier    sandbox PoC runner + verdict + CVSS recompute + dedup
    ├── dsh-hard-stopgate    chặn kết thúc turn sớm (agent/turn-stopping)
    ├── dsh-hard-standby     quota/rate-limit standby (agent/request-error + schedule)
    ├── dsh-hard-handoff     state handoff quanh compaction (observer + inject)
    ├── dsh-hard-rounds      round driver (theo pattern goal-round-driver)
    └── dsh-hard-deepread    fan-out subagent đọc module → flow doc có cấu trúc
```

Đặt package dưới `packages/experimental/hard-*` (pre-stable prototype, public by default theo đúng quy tắc nhóm `experimental/`), thăng cấp lên nhóm riêng khi ổn định. Các plugin **chỉ phụ thuộc capability seam** (`ctx.goals`, `ctx.sessions`, `ctx.schedule`, shell/sandbox, `ctx.systemPrompt`, `ctx.subagents`) — không bao giờ import thẳng `packages/core/agent-loop`.

## 5. Data model

### 5.1 Typed session events (merge vào `SessionEventMap`, có `@mode` + `@param` JSDoc; event tần suất cao đánh `ignorable: true`)

| Event | Payload chính |
|---|---|
| `hard/mission/armed` | objective, targetRepo, commit, maxRounds, configSnapshot |
| `hard/finding/proposed` | id `F-nn`, title, bugClass, component, claim, cvssVector, cvssClaimed, pocPath, hypothesisId? |
| `hard/finding/verdict` | id, verdict `confirmed\|refuted\|flaky`, runs, evidence (exit, sanitizer tail, stdout tail, duration), cvssComputed, rootFingerprint |
| `hard/hypothesis/state` | id `H-nn`, statement, status `proposed\|testing\|confirmed\|refuted\|deferred`, evidenceRefs, age |
| `hard/coverage/cell` | module, bugClass, verdict `cleared\|suspicious\|uncovered`, evidenceRefs, declaredSinks |
| `hard/sweep/summary` | sweepId, phase `A\|B`, cellsTouched, newFindings, emptyProof |
| `hard/standby/scheduled` | reason (quota\|outage), wakeAt, providerCode |
| `hard/round/start` / `hard/round/end` | round, budgetUsed, openWorkCount |

### 5.2 File artifacts (event chỉ ghi path + hash — file lớn không nhét vào log)

```
.dsh-hard/
  flow/<module>.md        # flow doc: dataflow, trust boundaries, state machines, assumptions
  poc/F-nn/               # PoC script + runner metadata + logs các lần chạy
  REPORT.md               # bản nháp disclosure (sinh khi hoàn thành)
```

Quy tắc: những gì được bơm vào prompt (handoff, section) phải tái tạo được từ log — do đó event lưu path + hash, và handoff inject tổng hợp *từ ledger events*, không đọc lén file ngoài log.

## 6. Verification contract (chống hallucination — lõi của thiết kế)

Một finding chỉ chuyển sang `confirmed` khi **tất cả** điều kiện sau thỏa:

1. **PoC do harness chạy, không phải model chạy rồi tự báo.** Verifier nhận `pocPath` từ tool `hard_submit_finding`, tự thực thi qua shell seam trong sandbox `strict`, timeout theo config.
2. **Observable effect khớp loại claim.** Verifier đối chiếu effect class với bug class: memory-safety phải cho tín hiệu ASan/UBSan hoặc crash có thể tái lập; authz bypass phải qua differential check (hai quyền, hai kết quả); injection phải có evidence lệnh/Truy vấn đã thoát khỏi context dự kiến. Claim không Ghim được vào effect quan sát được ⇒ REFUTED.
3. **Deterministic.** Chạy `runs` lần (mặc định 3) cùng kết quả. Không ⇒ `flaky`, trả logs về model để sửa PoC; finding flaky **không đếm**.
4. **CVSS tính lại từ vector.** Model cung cấp vector string (mặc định **CVSS v4.0**; engine tính đúng theo spec của phiên bản đã chọn, v3.1 vẫn hỗ trợ qua config) + điểm tự tính. Verifier có module deterministic vector → score (bảng lookup theo spec v4.0 của FIRST, test vectors lấy từ spec); điểm lệch ⇒ trả về để model sửa vector/suy luận lại severity. Impact narrative trong finding phải trỏ vào effect đã verify ở điều kiện 2, không được suy diễn ngoài PoC.
5. **Dedup theo root cause.** Fingerprint = normalize(file, symbol/hàm chứa, bugClass). Trùng fingerprint ⇒ merge vào finding cũ, không cộng điểm mới.
6. **REFUTED cũng là tiến bộ.** Bác bỏ có bằng chứng được ghi nhận, đóng hypothesis, tính vào progress. Model không bị phạt vì refuted — chỉ bị chặn vì fabricate (claim không chạy được / effect sai).

**Empty-sweep rule:** một vòng "không tìm thấy gì" chỉ được công nhận khi kèm (a) ≥ 1 hypothesis bị refuted bằng evidence, hoặc (b) ≥ 1 coverage cell chuyển `cleared` kèm bằng chứng liệt kê sinks/sources. Kết luận trống trơn là vô hiệu.

**Chống "chơi game" coverage (deterministic cross-check):** khi model đánh một cell `cleared` và khai danh sách sinks đã kiểm tra, harness tự grep các sink pattern của bug class đó trên module; model khai thiếu sink mà grep tìm ra ⇒ cell tự động reopen kèm bằng chứng. Tỉ lệ spot-check là config.

## 7. Methodology enforcement

### Phase A — systematic source–sink sweep
- Coverage matrix `modules × bugClasses` (danh sách class từ config; module list sinh từ cây target repo lúc arm).
- Mỗi cell: model liệt kê sources/sinks/guards trong module cho class đó → kết luận `cleared`/`suspicious` kèm refs. `suspicious` ⇒ buộc mở hypothesis. Không cell nào được bỏ qua không verdict.
- Thứ tự ưu tiên do model chọn theo risk, stopgate chỉ đòi đủ phủ.

### Phase B — creative deep-read
- `dsh-hard-deepread` fan-out subagent (một child mỗi module/cụm module) trả **flow doc có cấu trúc**: entry points, dataflow, trust boundaries, state machines, assumptions, "quirks đáng ngờ".
- Session chính tổng hợp flow docs ⇒ đặt hypothesis `H-nn` cho mọi quirks khả nghi — gồm logic bug, race, design flaw, exploit chain, tức đúng những thứ pattern source–sink không bắt được.
- **Lifecycle bắt buộc cho hypothesis:** `proposed → testing (phải nêu cách thử) → confirmed/refuted`. `deferred` phải nêu lý do + điều kiện retry; hypothesis quá `hypothesisAgeLimit` vòng không có progress ⇒ stopgate đánh dấu và đòi xử lý.
- **Luân phiên A/B:** cứ mỗi `deepReadEveryN` vòng sweep A thì một nhịp B (config).

## 8. Luồng vận hành một vòng

1. **Round start** — round driver xếp user prompt `<hard_round n/max>` (pattern `goal-round-driver`: reserve khi agent idle, fence bằng `agent/pre-step`), kèm danh sách open work từ ledger.
2. **Model làm việc** — đọc code, gọi `dsh-hard-tools`, chạy thử PoC qua bash tool, submit finding → verification chạy background job (`packages/jobs`), kết quả đổ về đầu step kế tiếp.
3. **Model thử kết thúc turn** — stopgate (serial listener `agent/turn-stopping`) hỏi ledger:
   - Còn open work (PoC chưa verify, cell chưa verdict, hypothesis chưa resolved, standby đang chờ)? ⇒ `agent.steer()` với **mệnh lệnh cụ thể** ("F-3 flaky, sửa PoC theo logs", "cell parser×sqli chưa verdict", "H-7 đã 4 vòng không progress"). Pattern đã chứng minh: bridge hook `Stop` của Claude Code (`packages/hooks/hooks-claude-code`).
   - Không còn open work nhưng chưa đạt completion gate (§8.6)? ⇒ steer sang nhịp kế (B-sweep, spot-check…).
4. **Compaction giữa chừng** — compaction mặc định chạy ở `agent/pre-step`, log nguyên vẹn; `dsh-hard-handoff` nghe `compaction/end` và `agent.inject()` bản handoff tổng hợp từ ledger (findings/hypotheses/coverage còn mở). Mission contract + ràng buộc bất biến nằm trong **system-prompt section — miễn nhiễm compaction** vì được assemble lại mỗi step.
5. **Quota / rate limit** — `llm-retry` (normal mode: 5 lần, backoff 500ms→10s, tôn trọng `Retry-After`) gánh nhiễu ngắn. Lỗi `QUOTA` terminal ⇒ `dsh-hard-standby` nghe `agent/request-error`, flush session, đặt lịch one-shot qua `ctx.schedule` đúng giờ reset (cron config hoặc lấy từ header provider); Host restore session và bơm `followup()` khi đến giờ ⇒ round mới tự chạy. Stopgate thấy `hard/standby/scheduled` chưa wake ⇒ cho turn đóng sạch sẽ (không cãi).
6. **Completion gate** (trong stopgate/mission, tất cả là config): mọi cell verdicted ∧ mọi hypothesis resolved ∧ `emptySweepsToFinish` sweep cuối đều empty-verified ∧ điều kiện tối thiểu về findings ⇒ `ctx.goals.complete()` + sinh nháp `REPORT.md` hướng disclosure.

## 9. Config schema (cordis.yml)

```yaml
hard:
  target:
    repoPath: /path/to/oss-repo        # bắt buộc, fails loud nếu thiếu
    commit: HEAD                        # pin commit để verify tái lập
    buildCommand: ~                     # chạy 1 lần lúc arm, được phép mạng
    testCommand: ~                      # dùng để đối chiếu regression khi verify
  rounds:
    maxRounds: 64
    stepsPerRound: 200                  # trần step/vòng, chống runaway (cancel qua turn-stopping)
    emptySweepsToFinish: 2
  methodology:
    bugClasses: [sqli, xss, cmdi, path-traversal, open-redirect, deserialization, ssrf, authn, authn-bypass, login-bypass, oauth-bypass, session, authz, crypto-misuse, misconfig, dependencies, race]
    deepReadEveryN: 3
    hypothesisAgeLimit: 5
    coverageSpotCheckPercent: 20
  verifier:
    runs: 3
    timeoutSeconds: 120
    sandbox: strict
    networkDuringPoc: deny
    cvssVersion: "4.0"                  # v3.1 vẫn hỗ trợ qua config
  standby:
    enabled: true
    quotaResetCron: ~                   # ~ = thử lấy từ Retry-After/header; else fails loud
    maxStandbyHours: 24
  budget:
    maxWallClockHours: ~                # ~ = không trần
    pauseOnBudget: true
```

## 10. Ánh xạ yêu cầu → seam có sẵn (đã verify trong repo)

| Yêu cầu | Seam / pattern | Nguồn |
|---|---|---|
| Chặn dừng sớm | serial `agent/turn-stopping` + `agent.steer()` | `packages/hooks/hooks-claude-code/README.md` (hook `Stop`) |
| Vòng lặp round | reservation khi idle + fence `agent/pre-step` | `packages/goal/goal-round-driver/README.md` |
| Goal bền vững | `ctx.goals.create/edit/pause/complete` | `docs/subsystems/goal.md` |
| Retry nhiễu ngắn | `llm-retry` normal mode | `packages/llm/llm-retry/README.md` |
| Standby qua quota | `agent/request-error` + `ctx.schedule` one-shot, Host restore session | `docs/subsystems/schedule.md` |
| Compaction | tự động ở `agent/pre-step`, log nguyên vẹn; inject sau `compaction/end` | `docs/subsystems/compaction.md` |
| Bơm context mỗi step | `ctx.systemPrompt.section/context`, `agent.inject()`, tool `additionalContexts` | `docs/subsystems/system-prompt.md` |
| Chạy PoC an toàn | shell seam + sandbox providers (bwrap/Landlock/Seatbelt) | `packages/sandbox` |
| Fan-out đọc module | `ctx.subagents` + tool-subagent | `docs/architecture.md` |
| Verify chạy nền | `packages/jobs` + completion notices | `docs/` |

## 11. Phase 2 (optional — chỉ khi cần ngữ nghĩa cứng hơn)

1. **Hard veto `turn/end`** trong agent-loop: hiện turn-stopping chỉ cho steer; nếu muốn "turn không bao giờ khép khi goal active" đúng nghĩa (assistant text cuối không bao giờ bị coi là câu trả lời) mới cần sửa loop.
2. **Sibling compaction backend** soạn summary có cấu trúc (thay vì inject sau `compaction/end`).
3. **In-loop evaluator** chứng nhận completion như bất biến của loop (hiện goal cố tình.defer).
4. **Client UI cho profile `hard`** (Web/desktop: card tiến độ rounds/coverage, nút pause, bảng findings + CVSS) — headless-first, UI bổ sung khi core loop ổn định.

Không cái nào blocker cho MVP.

## 12. Kế hoạch implement — 5 PR

| PR | Nội dung | Tests |
|---|---|---|
| 1 | Bundle `dsh-hard` skeleton + config schema + `mission` (arm goal, section) + `stopgate` (decision table đầy đủ) | Unit 100% coverage cho `src/*`; decision-table tests cho stopgate |
| 2 | `ledger` (events + service) + `tools` + `verifier` (sandbox runner, verdict classifier, CVSS recompute test theo spec FIRST, dedup fingerprint) | Unit; CVSS vectors từ spec làm fixture; classifier test cả 3 verdict + fabrication-reject |
| 3 | `standby` (request-error listener, schedule integration, state machine wake) + `handoff` (compaction observer, handoff builder) | Unit; state machine standby; handoff content test |
| 4 | `rounds` (driver) + `deepread` (subagent template) + cross-check grep cho coverage + luân phiên A/B | Unit; driver reservation/fence tests |
| 5 | Profile `hard` wiring + docs (subsystem doc, tool catalog, apps/cli README, packages/experimental README) + snapshot harness support (nếu thiếu cho profile mới) + fixture repo (2 bug planted: 1 source–sink, 1 logic) + fabrication trap + recorded snapshot + e2e key-gated | `pnpm run test:snapshot -t <hard>`; e2e tự-skip không key |

Mỗi PR chạy pre-push checks theo `dsh-pre-push-checks` (focused tests + `doc-sync` cho docs), không chạy full suite. Tool definitions tuân theo skill `agent-experience` (name/description/schema + system-prompt section). Event JSDoc đủ `@mode`/`@param` theo quy tắc `SessionEventMap`.

Fixture e2e phải chứa **bẫy anti-hallucination**: kịch bản lôi kéo model tuyên bố xong sớm (stopgate phải từ chối) và submit một finding không có PoC thật (verifier phải REFUTED).

## 13. Rủi ro & biện pháp

| Rủi ro | Biện pháp |
|---|---|
| Chi phí token vòng vô hạn | `maxRounds`, `stepsPerRound`, `maxWallClockHours`, `pauseOnBudget`; `goal pause` luôn khả dụng cho người |
| Model đánh `cleared` bừa | Spot-check grep deterministic (§6); lệch ⇒ reopen kèm bằng chứng |
| PoC lợi dụng quyền để escape sandbox | Sandbox `strict`, deny network lúc chạy PoC; build dependencies là phase riêng có mạng; evidence escape ⇒ dừng + ghi sự kiện |
| Model bịa bug cho có | §6 toàn bộ; REFUTED được ghi nhận là tiến bộ để model không bị ép đến mức phải bịa |
| Hành vi khác nhau theo model | Steering độ cứng là config; snapshot ghi hành vi chuẩn để regression |
| Đạo đức/pháp lý | Target phải là repo người dùng được phép audit (code của họ / OSS định disclosure); REPORT.md hướng responsible disclosure; không auto-exploit từ xa |

## 14. Quyết định đã chốt (2026-10-04)

1. **CVSS mặc định v4.0** (dùng spec mới; v3.1 vẫn chọn được qua `verifier.cvssVersion`).
2. **Thêm nhóm authentication vào bugClasses mặc định cho Phase A:** `authn` (broken authentication: credential/session handling), `authn-bypass` (authentication bypass), `login-bypass` (lỗi luồng login: thứ tự kiểm tra, tài khoản mặc định, magic link), `oauth-bypass` (OAuth flow: redirect validation, consent/state/PKCE, token exchange). Các lớp này có nguồn/sink rõ nên xét ở Phase A, phần biến thể logic (bypass qua state confusion) vẫn thuộc Phase B.
3. **Headless-first** — PR 1–5 không đụng client; UI (Web/desktop) là Phase 2 mục 4.
4. **Phase A phủ đủ OWASP Top 10 với source-sink đầy đủ** — bổ sung `open-redirect`, `session` (session fixation/flag), `misconfig` (A05), `dependencies` (A06: manifest/pin → vulnerable API call). A04 (insecure design) và A09 (security logging) không có cặp source→sink cơ học nên thuộc Phase B deep-read.
