import { useState } from "react";
import { CheckIcon, CopyIcon, TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Server } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

type CommandKey = "install" | "upgrade" | "uninstall" | "stop" | "restart";

const COMMAND_ORDER: CommandKey[] = [
  "install",
  "upgrade",
  "uninstall",
  "stop",
  "restart",
];

/**
 * 服务器命令面板：主控返回的运维命令只做展示与复制，不在前端执行任何远程操作。
 * `install` 只在创建/重置后返回一次，为空时不占位。
 */
export function ServerCommandsDialog({
  open,
  onOpenChange,
  server,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: Server;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<CommandKey | null>(null);
  const commands = server.commands;

  const rows = commands
    ? COMMAND_ORDER.flatMap((key) => {
        const command = commands[key];
        if (!command) return [];
        return [{ key, command, label: t(`servers.commands.${key}`) }];
      })
    : [];

  async function handleCopy(key: CommandKey, label: string, command: string) {
    if (!(await copyText(command))) {
      toast.error(t("servers.commands.copyFailed"));
      return;
    }
    setCopied(key);
    toast.success(t("servers.commands.copied", { label }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TerminalIcon className="icon-md text-primary" />
            {t("servers.commands.title")}
          </DialogTitle>
          <DialogDescription>
            {t("servers.commands.desc", { name: server.name })}
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t("servers.commands.notReady")}
          </p>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium">{row.label}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void handleCopy(row.key, row.label, row.command)
                    }
                  >
                    {copied === row.key ? (
                      <CheckIcon className="text-primary" />
                    ) : (
                      <CopyIcon />
                    )}
                    {copied === row.key
                      ? t("common.copied")
                      : t("common.copy")}
                  </Button>
                </div>
                <pre
                  className={cn(
                    "max-h-28 overflow-auto rounded-lg border border-border bg-muted/30 p-3",
                    "font-mono text-xs leading-normal break-words whitespace-pre-wrap",
                  )}
                >
                  {row.command}
                </pre>
              </div>
            ))}
            {commands?.install ? null : (
              <p className="text-xs text-muted-foreground">
                {t("servers.commands.emptyInstall")}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
