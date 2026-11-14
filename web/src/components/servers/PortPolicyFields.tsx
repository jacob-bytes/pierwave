import { useState } from "react";
import { XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  formatPortRangeText,
  invalidPortAllowTokens,
  parsePortAllow,
  parsePortRangeText,
} from "@/lib/portPolicy";
import { useI18n } from "@/i18n";

interface PortPolicyFieldsProps {
  /** 起始端口输入（空串 = 不限制）。 */
  start: string;
  /** 结束端口输入（空串 = 不限制）。 */
  end: string;
  /** 额外允许的端口，已去重升序。 */
  allow: readonly number[];
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onAllowChange: (ports: number[]) => void;
  disabled?: boolean;
  /** 范围校验失败时的文案（与额外端口的行内错误分开）。 */
  error?: string | null;
  /** 同页多个表单时避免 id 冲突。 */
  idPrefix?: string;
}

/**
 * 服务器创建 / 编辑共用的「允许的端口」区块。
 *
 * 起始 / 结束两个可选输入 + 额外允许端口的 tag 输入；留空表示不限制。
 * tag 输入支持逗号、中文逗号与回车添加，非法端口留在输入框里并就地报错，
 * 避免把用户输入悄悄吞掉。
 */
export function PortPolicyFields({
  start,
  end,
  allow,
  onStartChange,
  onEndChange,
  onAllowChange,
  disabled = false,
  error,
  idPrefix = "server-port",
}: PortPolicyFieldsProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  // 范围输入自己保存原始文本，提交时再解析成 start/end；
  // 这样用户能中途输入「30000-」而不被立刻改写。
  const [rangeDraft, setRangeDraft] = useState(() =>
    formatPortRangeText(start, end),
  );
  const rangeInvalid =
    rangeDraft.trim() !== "" && parsePortRangeText(rangeDraft) === null;

  function handleRangeChange(next: string) {
    setRangeDraft(next);
    const parsed = parsePortRangeText(next);
    if (parsed) {
      onStartChange(parsed.start === null ? "" : String(parsed.start));
      onEndChange(parsed.end === null ? "" : String(parsed.end));
    } else {
      // 解析失败必须把父级的值清空：否则提交时会拿上一次的合法值静默提交，
      // 用户看到「输入了 30000-」，保存下来的却是旧范围。
      onStartChange("");
      onEndChange("");
    }
  }

  function commit(raw: string) {
    if (raw.trim() === "") return;
    if (invalidPortAllowTokens(raw).length > 0) {
      setTagError(t("servers.portPolicy.allowInvalid"));
      return;
    }
    const merged = new Set([...allow, ...parsePortAllow(raw)]);
    onAllowChange([...merged].sort((left, right) => left - right));
    setText("");
    setTagError(null);
  }

  function removePort(port: number) {
    onAllowChange(allow.filter((item) => item !== port));
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3">
      <span className="text-xs font-medium">
        {t("servers.portPolicy.section")}
      </span>

      {/* 起止合并成一个输入：范围本来就是一个概念，两个框还多占一行高度。 */}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-range`} className="text-xs">
          {t("servers.portPolicy.rangeLabel")}
        </Label>
        <Input
          id={`${idPrefix}-range`}
          value={rangeDraft}
          onChange={(event) => handleRangeChange(event.target.value)}
          placeholder={t("servers.portPolicy.rangePlaceholder")}
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          disabled={disabled}
          className="h-8 font-mono tabular-nums"
          aria-invalid={rangeInvalid}
        />
        {rangeInvalid ? (
          <p role="alert" className="text-xs text-destructive">
            {t("servers.portPolicy.rangeInvalid")}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-allow`} className="text-xs">
          {t("servers.portPolicy.allowLabel")}
        </Label>

        {allow.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {allow.map((port) => (
              <span
                key={port}
                className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background py-0.5 pr-0.5 pl-1.5 font-mono text-xs tabular-nums"
              >
                {port}
                <button
                  type="button"
                  aria-label={t("servers.portPolicy.removeAria", { port })}
                  disabled={disabled}
                  onClick={() => removePort(port)}
                  className="grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors duration-150 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  <XIcon className="size-3" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <Input
          id={`${idPrefix}-allow`}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (tagError) setTagError(null);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" ||
              event.key === "," ||
              event.key === "，"
            ) {
              event.preventDefault();
              commit(text);
              return;
            }
            if (event.key === "Backspace" && text === "" && allow.length > 0) {
              removePort(allow[allow.length - 1]);
            }
          }}
          onBlur={() => commit(text)}
          placeholder={t("servers.portPolicy.allowPlaceholder")}
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled}
          aria-invalid={Boolean(tagError)}
          aria-describedby={
            tagError ? `${idPrefix}-allow-error` : undefined
          }
          className="h-8 font-mono tabular-nums"
        />
        {tagError ? (
          <p
            id={`${idPrefix}-allow-error`}
            role="alert"
            className="text-xs text-destructive"
          >
            {tagError}
          </p>
        ) : null}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("servers.portPolicy.hint")}
      </p>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
