import { useMemo, useState } from "react";
import {
  GlobeIcon,
  ListChecksIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { StatusDot } from "@/components/status/ServerCard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/errors";
import {
  filterPublicServerChoices,
  publicVisibilitySummary,
  sortPublicServerChoices,
} from "@/lib/publicStatusSettings";
import {
  usePublicStatusServers,
  useUpdatePublicStatusServers,
} from "@/lib/queries";
import type { SettingsGeneralValues } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/**
 * 「设置 → 常规 → 公开状态页」卡片。
 *
 * 三个分组共用一张卡：总开关、公开节点白名单、是否公开到期与价格。
 * 总开关与账期开关属于「常规」表单，随页面底部保存栏一起提交；
 * 白名单走自己的 `PUT /api/v1/public-status/servers`，在对话框里保存。
 *
 * 总开关关闭时，后两组整体置灰且不可编辑：它们只影响 /status，
 * 状态页本身对所有人不可见时，调整公开内容没有意义。
 */
export function PublicStatusCard({
  form,
  saving,
  billingSupported,
}: {
  form: UseFormReturn<SettingsGeneralValues>;
  saving: boolean;
  /** 后端是否已返回 `public_billing_visible`；旧后端不支持时不提交该键。 */
  billingSupported: boolean;
}) {
  useI18n();
  const servers = usePublicStatusServers();
  const updateServers = useUpdatePublicStatusServers();

  const statusEnabled = form.watch("public_status_enabled");
  const billingVisible = form.watch("public_billing_visible");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 名称排序在打开对话框与摘要计数前都做一次，保证列表顺序稳定。
  const items = useMemo(
    () => sortPublicServerChoices(servers.data ?? []),
    [servers.data],
  );
  const summary = useMemo(() => publicVisibilitySummary(items), [items]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visibleItems = useMemo(
    () => filterPublicServerChoices(items, query),
    [items, query],
  );

  // 只比较 id 集合：与当前已公开的节点一致时保存按钮不可点。
  const currentIds = useMemo(
    () =>
      items
        .filter((item) => item.public_visible === true)
        .map((item) => item.id)
        .sort(),
    [items],
  );
  const dirty =
    [...selected].sort().join("\u0000") !== currentIds.join("\u0000");

  const whitelistUnsupported = servers.isError;

  function openDialog() {
    setSelected(currentIds);
    setQuery("");
    setSaveError(null);
    setDialogOpen(true);
  }

  function toggle(id: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return [...next];
    });
  }

  function selectVisible() {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const item of visibleItems) next.add(item.id);
      return [...next];
    });
  }

  function saveWhitelist() {
    setSaveError(null);
    updateServers.mutate(selected, {
      onSuccess: () => {
        setDialogOpen(false);
        toast.success(t("settings.publicStatus.whitelist.saved"));
      },
      onError: (error) => {
        const message = errorText(
          error,
          t("settings.publicStatus.whitelist.saveError"),
        );
        // 失败保留对话框与草稿，管理员可以改完再试。
        setSaveError(message);
        toast.error(message);
      },
    });
  }

  return (
    <SettingsGroup
      icon={GlobeIcon}
      title={t("settings.publicStatus.title")}
      description={t("settings.publicStatus.desc")}
      contentClassName="md:grid-cols-2"
    >
      {/* 左列：总开关。关闭后公开页对所有人返回 404，是整张卡的前置条件。 */}
      <div className="space-y-2">
        <Label htmlFor="settings-public-status-enabled" className="cursor-pointer">
          {t("settings.publicStatus.enabled")}
        </Label>
        <Switch
          id="settings-public-status-enabled"
          checked={statusEnabled}
          disabled={saving}
          onCheckedChange={(next) => {
            form.setValue("public_status_enabled", next === true, {
              shouldDirty: true,
              shouldTouch: true,
            });
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.publicStatus.offWarning")}
        </p>
      </div>

      {/* 右列：账期隐私。总开关关闭时置灰禁用，但注释保留。 */}
      <div className={cn("space-y-2", !statusEnabled && "opacity-60")}>
        <Label
          htmlFor="settings-public-billing-visible"
          className={cn(
            billingSupported && statusEnabled && "cursor-pointer",
          )}
        >
          {t("settings.publicStatus.billing")}
        </Label>
        <Switch
          id="settings-public-billing-visible"
          checked={billingVisible}
          disabled={saving || !statusEnabled || !billingSupported}
          onCheckedChange={(next) => {
            form.setValue("public_billing_visible", next === true, {
              shouldDirty: true,
              shouldTouch: true,
            });
          }}
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.publicStatus.billingNote")}
        </p>
        {billingSupported ? null : (
          <p className="text-xs text-muted-foreground">
            {t("settings.publicStatus.whitelist.unsupported")}
          </p>
        )}
      </div>

      {/* 白名单整行跨两列：左侧标签 + 注释，右侧摘要 + 操作。 */}
      <div
        className={cn(
          "grid gap-2 md:col-span-2 md:grid-cols-2 md:items-start md:gap-x-5 md:gap-y-2",
          !statusEnabled && "opacity-60",
        )}
      >
        <div className="space-y-2">
          <span className="text-sm">
            {t("settings.publicStatus.whitelist.label")}
          </span>
          <p className="text-xs text-muted-foreground">
            {t("settings.publicStatus.whitelist.note")}
          </p>
        </div>

        <div className="md:flex md:justify-end">
          {servers.isPending ? (
            <div className="flex items-center gap-2" aria-busy="true">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-7 w-24" />
            </div>
          ) : whitelistUnsupported ? (
            <span className="text-xs text-muted-foreground">
              {t("settings.publicStatus.whitelist.unsupported")}
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="tnum text-xs text-muted-foreground" aria-live="polite">
                {t("settings.publicStatus.whitelist.summary", {
                  visible: summary.visible,
                  total: summary.total,
                })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openDialog}
                disabled={!statusEnabled || saving}
              >
                <ListChecksIcon />
                {t("settings.publicStatus.whitelist.choose")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          // 保存中不允许关闭，避免请求回来时对话框已经不存在。
          if (updateServers.isPending) return;
          setDialogOpen(open);
        }}
      >
        <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="border-b border-border px-4 py-3 pr-12">
            <DialogTitle>
              {t("settings.publicStatus.whitelist.dialogTitle")}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t("settings.publicStatus.whitelist.dialogDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {saveError ? (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("settings.publicStatus.whitelist.search")}
                aria-label={t("settings.publicStatus.whitelist.search")}
                className="pl-8"
                disabled={updateServers.isPending}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={selectVisible}
                  disabled={
                    updateServers.isPending || visibleItems.length === 0
                  }
                >
                  <ListChecksIcon />
                  {t("settings.publicStatus.whitelist.selectAll")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected([])}
                  disabled={updateServers.isPending || selected.length === 0}
                >
                  {t("settings.publicStatus.whitelist.clear")}
                </Button>
              </div>
              <span className="tnum text-xs text-muted-foreground" aria-live="polite">
                {t("settings.publicStatus.whitelist.selected", {
                  selected: selected.length,
                  total: items.length,
                })}
              </span>
            </div>

            <div className="mt-2">
              {visibleItems.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  {query.trim() === ""
                    ? t("settings.publicStatus.whitelist.empty")
                    : t("settings.publicStatus.whitelist.noMatch")}
                </p>
              ) : (
                <ScrollArea className="h-[min(46vh,20rem)]">
                  <div className="space-y-0.5 pr-3">
                    {visibleItems.map((server) => {
                      const checked = selectedSet.has(server.id);
                      const inputId = `public-status-server-${server.id}`;
                      const state = server.online ? "online" : "offline";
                      return (
                        <div
                          key={server.id}
                          className={cn(
                            "flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-muted/40",
                            checked && "bg-primary/5",
                          )}
                        >
                          <Checkbox
                            id={inputId}
                            checked={checked}
                            disabled={updateServers.isPending}
                            onCheckedChange={(next) =>
                              toggle(server.id, next === true)
                            }
                          />
                          <StatusDot state={state} />
                          <Label
                            htmlFor={inputId}
                            className="min-w-0 flex-1 cursor-pointer truncate font-normal"
                          >
                            {server.name}
                            <span className="sr-only">
                              {" "}
                              {t(
                                server.online
                                  ? "publicStatus.server.online"
                                  : "publicStatus.server.offline",
                              )}
                            </span>
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>

          <DialogFooter className="mx-0 mb-0 rounded-none border-border px-4 py-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={updateServers.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={saveWhitelist}
              disabled={updateServers.isPending || !dirty}
            >
              {updateServers.isPending ? (
                <Loader2Icon className="animate-spin" />
              ) : null}
              {updateServers.isPending
                ? t("settings.publicStatus.whitelist.saving")
                : t("settings.publicStatus.whitelist.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
