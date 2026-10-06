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
  'verdict.cleared': '已清除',
  'verdict.suspicious': '可疑',
  'verdict.uncovered': '未覆盖',
  'source.harness': '机器筛查',
  'source.modelVerified': '批量验证',
  'source.model': '模型读码',
  'column.module': '模块',
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
  'verdict.cleared': 'Cleared',
  'verdict.suspicious': 'Suspicious',
  'verdict.uncovered': 'Uncovered',
  'source.harness': 'Harness screen',
  'source.modelVerified': 'Batch verified',
  'source.model': 'Model read',
  'column.module': 'Module',
} satisfies Record<HardKey, string>
