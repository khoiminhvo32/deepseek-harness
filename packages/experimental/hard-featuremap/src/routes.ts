/**
 * The paths of the Host routes the browser feature map panel reads. This
 * module imports nothing, so a Client test can compare the panel's copies
 * against it without loading the Host service.
 * @module @deepseek-ai/dsh-experimental-hard-featuremap/routes
 */

/** The feature graph route: `?session=<id>&feature=<FE-n>`. */
export const FEATURE_GRAPH_PATH = '/api/hard-featuremap.feature'
/** The symbol detail route: `?session=<id>&symbol=<id>`. */
export const SYMBOL_DETAIL_PATH = '/api/hard-featuremap.symbol'
