/** Hard-harness Web dictionaries. Module and bug-class names are session data and stay untranslated. */

/** Locale namespace owned by the hard-harness Web UI. */
export const NS = 'hard'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  'tab.title': 'Hard 覆盖矩阵',
  'guide.title': 'Hard 覆盖矩阵',
  'guide.description': '查看目标覆盖矩阵与完成门状态',
  loading: '正在加载台账…',
  empty: '覆盖矩阵尚未武装；任务启动后这里会显示矩阵。',
  'gate.certified': '完成门已认证',
  'gate.blocked': '完成门未通过',
  progress: '已判定',
  target: '目标',
  'scope.repo': '整个仓库',
  'column.module': '模块',
  'face.model': '已清除 · 模型读码',
  'face.modelVerified': '已清除 · 批量验证',
  'face.harness': '已清除 · 机器筛查',
  'face.suspiciousHarness': '可疑 · 机器复核打回',
  'face.suspiciousModel': '可疑 · 模型自报',
  'verdict.uncovered': '未覆盖',
} satisfies Record<string, string>

/** Hard-harness locale key union. */
export type HardKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  'tab.title': 'Hard coverage matrix',
  'guide.title': 'Hard coverage matrix',
  'guide.description': 'See the target coverage matrix and the completion gate',
  loading: 'Loading ledger…',
  empty: 'The coverage matrix is not armed yet; it appears here once the mission arms.',
  'gate.certified': 'Completion gate certified',
  'gate.blocked': 'Completion gate open work',
  progress: 'verdicted',
  target: 'Target',
  'scope.repo': 'Repository',
  'column.module': 'Module',
  'face.model': 'Cleared · model read',
  'face.modelVerified': 'Cleared · batch verified',
  'face.harness': 'Cleared · harness screen',
  'face.suspiciousHarness': 'Suspicious · harness re-open',
  'face.suspiciousModel': 'Suspicious · model sighting',
  'verdict.uncovered': 'Uncovered',
} satisfies Record<HardKey, string>
