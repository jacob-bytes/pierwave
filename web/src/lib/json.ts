/**
 * config 文本框的 JSON 校验。
 *
 * 只做「能不能 parse + 顶层是不是对象 + 出错在哪里」三件事，
 * 不引第三方编辑器；错误统一翻成中文并带行/列号。
 */

export interface JsonIssue {
  message: string;
  line?: number;
  column?: number;
}

export type JsonParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issue: JsonIssue };

function atLineColumn(
  text: string,
  offset: number,
  prefix = "JSON 语法错误",
): JsonIssue {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const line = before.split("\n").length;
  const column = clamped - before.lastIndexOf("\n");
  return {
    message: `${prefix}：第 ${line} 行第 ${column} 列附近，请检查括号、引号与逗号`,
    line,
    column,
  };
}

/**
 * V8 的错误信息不稳定：有的带 position/line，有的只有
 * `Unexpected end of JSON input` 或 `Unexpected token '}'`。
 * 这里把能拿到的位置都翻成行号，拿不到时用 token / 文本末尾兜底，
 * 保证用户至少能定位到出错的行。
 */
function locateError(text: string, error: unknown): JsonIssue {
  const raw = error instanceof Error ? error.message : String(error);

  const lineColumn = /line (\d+) column (\d+)/i.exec(raw);
  if (lineColumn) {
    return atLineColumn(
      text,
      offsetAtLineColumn(text, Number(lineColumn[1]), Number(lineColumn[2])),
    );
  }

  const position = /position (\d+)/i.exec(raw);
  if (position) {
    return atLineColumn(text, Number(position[1]));
  }

  if (/unexpected end of json input/i.test(raw)) {
    return atLineColumn(text, text.length, "JSON 在这里意外结束");
  }

  const token = /unexpected token '(.+?)'/i.exec(raw);
  if (token) {
    const needle = token[1].replace(/\\\\/g, "\\");
    const offset = text.indexOf(needle);
    if (offset >= 0) {
      return atLineColumn(text, offset, `JSON 中出现了不该出现的「${needle}」`);
    }
  }

  return atLineColumn(text, text.length);
}

function offsetAtLineColumn(
  text: string,
  line: number,
  column: number,
): number {
  const lines = text.split("\n");
  const safeLine = Math.max(1, Math.min(line, lines.length));
  let offset = 0;
  for (let index = 0; index < safeLine - 1; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset + Math.max(1, column) - 1;
}

export function parseJsonConfig(text: string): JsonParseResult {
  const trimmed = text.trim();

  if (!trimmed) {
    return {
      ok: false,
      issue: { message: "config 不能为空，至少需要包含一个 { } 对象" },
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, issue: locateError(text, error) };
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      issue: { message: "config 必须是 JSON 对象（以 { 开头、} 结尾）" },
    };
  }

  return { ok: true, value: value as Record<string, unknown> };
}

export function formatJsonObject(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
