/**
 * The packaged Joern query. It writes fact format 1 (see `facts.ts`) for one
 * code property graph and takes two parameters, `cpgFile` and `outFile`. The
 * service writes this text into each build directory and passes only that
 * file and harness-built paths to Joern.
 * @module @deepseek-ai/dsh-experimental-hard-cpg/query
 */

/** The Scala source of the packaged query; its digest keys the fact cache. */
export const HARD_CPG_FACTS_QUERY = String.raw`// Exports the facts hard-cpg reads from one code property graph as JSON Lines,
// in fact format 1: a header, then files, internal methods, and call sites
// with resolved internal targets and bounded argument summaries, then an end
// marker. Usage: --param cpgFile=<cpg> --param outFile=<jsonl>.
import io.shiftleft.semanticcpg.language._
import io.shiftleft.codepropertygraph.generated.nodes.{Block, Expression, Literal}
import java.io.{BufferedWriter, FileOutputStream, OutputStreamWriter}
import java.nio.charset.StandardCharsets

@main def main(cpgFile: String, outFile: String) = {
  importCpg(cpgFile)
  val out = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(outFile), StandardCharsets.UTF_8))
  def emit(v: ujson.Value): Unit = { out.write(ujson.write(v)); out.write('\n') }
  def bounded(s: String, n: Int): String = if (s.length <= n) s else s.take(n)
  def line(n: Option[Int]): ujson.Value = n.map(v => ujson.Num(v.toDouble)).getOrElse(ujson.Null)
  // The frontend desugars an array literal argument into a block of temporary
  // assignments; its element values are what a callback array names.
  def arrayItems(b: Block): List[String] =
    b.astChildren.isCall.nameExact("<operator>.assignment").argument(2).code.filterNot(_ == "array()").map(bounded(_, 120)).take(8).l
  def arg(e: Expression): ujson.Value = e match {
    case l: Literal => ujson.Obj("lit" -> bounded(l.code, 200))
    case b: Block if b.astChildren.isCall.nameExact("<operator>.assignment").argument(2).isCall.nameExact("array").nonEmpty =>
      ujson.Obj("arr" -> ujson.Arr.from(arrayItems(b).map(ujson.Str(_))))
    case other => ujson.Obj("code" -> bounded(other.code, 120))
  }
  emit(ujson.Obj("k" -> "header", "format" -> 1))
  cpg.file.name.filterNot(_.startsWith("<")).foreach(f => emit(ujson.Obj("k" -> "file", "path" -> f)))
  cpg.method.isExternal(false).foreach { m =>
    emit(ujson.Obj("k" -> "method", "id" -> m.fullName, "name" -> m.name, "file" -> m.filename,
      "line" -> line(m.lineNumber), "end" -> line(m.lineNumberEnd)))
  }
  cpg.call.filterNot(_.name.startsWith("<operator")).foreach { c =>
    emit(ujson.Obj("k" -> "call", "caller" -> c.method.fullName, "name" -> c.name, "target" -> c.methodFullName,
      "resolved" -> ujson.Arr.from(c.callee.isExternal(false).fullName.dedup.l.map(ujson.Str(_))),
      "file" -> c.method.filename, "line" -> line(c.lineNumber),
      "dispatch" -> (if (c.dispatchType == "DYNAMIC_DISPATCH") "dynamic" else "static"),
      "args" -> ujson.Arr.from(c.argument.filter(_.argumentIndex > 0).sortBy(_.argumentIndex).take(4).map(arg).l)))
  }
  emit(ujson.Obj("k" -> "end"))
  out.close()
}
`
