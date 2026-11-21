import { useState } from "react";
import type { FormEvent } from "react";
import {
  Loader2Icon,
  SlidersHorizontalIcon,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CountrySelect } from "@/components/common/CountrySelect";
import { BillingFields } from "@/components/servers/BillingFields";
import { NicField } from "@/components/servers/NicField";
import { PortPolicyFields } from "@/components/servers/PortPolicyFields";
import { displayAgentVersion } from "@/lib/agentUpgrade";
import type { Server } from "@/lib/api";
import { isCountryCode } from "@/lib/country";
import { errorText, isNotFound } from "@/lib/errors";
import { nicLabel, nicState } from "@/lib/nic";
import {
  normalizePortPolicy,
  parsePortRangeInput,
} from "@/lib/portPolicy";
import {
  billingFieldForError,
  billingFormFromServer,
  billingPayload,
  translateBillingErrors,
  validateBillingForm,
  type BillingFieldErrors,
  type ServerBillingForm,
} from "@/lib/serverBilling";
import { useUpdateServer } from "@/lib/queries";
import {
  GROUP_NAME_MAX_LENGTH,
  normalizeGroupName,
} from "@/lib/serverGroups";
import { t } from "@/i18n";


interface ServerEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: Server;
}

/**
 * 服务器设置：目前只有 P4 的「允许下发升级」开关。
 *
 * 开关不即时生效，点「保存修改」才 PATCH；后端可能暂时 404，
 * 这里统一兜底成可翻译的中文错误，不写入任何 mock 数据。
 */
export function ServerEditDialog({
  open,
  onOpenChange,
  server,
}: ServerEditDialogProps) {

  const updateServer = useUpdateServer();
  // Dialog 只在选中服务器时挂载，初始值就是最新值；不跟随轮询覆盖未保存的修改。
  const [allowUpgrade, setAllowUpgrade] = useState(() =>
    Boolean(server.allow_agent_upgrade),
  );
  const [countryCode, setCountryCode] = useState(
    () => server.country_code ?? "",
  );
  const [groupName, setGroupName] = useState(
    () => normalizeGroupName(server.group_name) ?? "",
  );
  const [nicName, setNicName] = useState<string | null>(() =>
    nicLabel(server.nic_name),
  );
  // 未上报 / 没有网卡时下拉禁用：此时不要把旧值随 PATCH 发回去，
  // 否则只改其它设置也可能被后端以 `server.nic_unknown` 拒绝。
  const nic = nicState(server);
  const nicEditable = nic === "verified" || nic === "unset";
  const [portStart, setPortStart] = useState(() =>
    server.port_start == null ? "" : String(server.port_start),
  );
  const [portEnd, setPortEnd] = useState(() =>
    server.port_end == null ? "" : String(server.port_end),
  );
  // 旧后端的 port_allow 可能缺失或含脏值：归一化后再进输入框。
  const [portAllow, setPortAllow] = useState<number[]>(
    () => normalizePortPolicy(server).allow,
  );
  const [internalAddress, setInternalAddress] = useState(
    () => server.internal_address ?? "",
  );
  // 编辑回填：后端读路径已把脏值降级为 null，这里再兜一层。
  const [billing, setBilling] = useState<ServerBillingForm>(() =>
    billingFormFromServer(server),
  );
  const [billingErrors, setBillingErrors] = useState<BillingFieldErrors>({});
  // 改哪一格就清哪一格的旧错误，避免「价格已经填了却还挂着缺价格」。
  const updateBilling = (next: ServerBillingForm) => {
    setBillingErrors((current) => {
      const remaining = { ...current };
      if (next.paidUntil !== billing.paidUntil) delete remaining.paid_until;
      if (next.price !== billing.price) delete remaining.price_cents;
      if (next.currency !== billing.currency) delete remaining.currency;
      // 数量 / 单位是一对：改任何一半都清掉整对的行内错误。
      if (next.cycleCount !== billing.cycleCount) {
        delete remaining.billing_cycle_count;
        delete remaining.billing_cycle_unit;
      }
      if (next.cycleUnit !== billing.cycleUnit) {
        delete remaining.billing_cycle_unit;
        delete remaining.billing_cycle_count;
      }
      return remaining;
    });
    setBilling(next);
  };
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (updateServer.isPending) return;

    const normalizedCountry = countryCode.trim().toUpperCase();
    if (normalizedCountry && !isCountryCode(normalizedCountry)) {
      setError(t("servers.countryInvalid"));
      return;
    }

    const portRange = parsePortRangeInput(portStart, portEnd);
    if (!portRange) {
      setError(t("servers.portPolicy.rangeInvalid"));
      return;
    }

    // 费用字段前端先校验：错误只落在字段下方，不弹 toast、不发请求。
    const nextBillingErrors = validateBillingForm(billing);
    if (Object.keys(nextBillingErrors).length > 0) {
      setBillingErrors(translateBillingErrors(nextBillingErrors, t));
      return;
    }
    setBillingErrors({});

    setError(null);
    try {
      await updateServer.mutateAsync({
        id: server.id,
        input: {
          allow_agent_upgrade: allowUpgrade,
          country_code: normalizedCountry,
          // 后端把空串当作「清空分组」；null 可能被当成「不改该字段」。
          group_name: normalizeGroupName(groupName) ?? "",
          // 两个都 null = 不限制；额外端口空数组 = 没有额外端口。
          port_start: portRange.start,
          port_end: portRange.end,
          port_allow: portAllow,
          // 空串 = 清空内网地址；不用空串占位，避免链侧把它当成已填写。
          internal_address: internalAddress.trim() || null,
          // null = 不限制；不可校验时省略该字段，保留服务器上的原值。
          ...(nicEditable ? { nic_name: nicName } : {}),
          // 四个费用字段始终显式提交：留空发 null 才是真的清空（PATCH 三态：
          // 缺省 = 不改，null = 清空），不能省略。
          ...billingPayload(billing),
        },
      });
      toast.success(t("servers.editDialog.saved"));
      onOpenChange(false);
    } catch (submitError) {
      // 后端权威校验：错误码映射回对应字段，行内显示，不再重复 toast。
      const field = billingFieldForError(submitError);
      if (field) {
        setBillingErrors({
          [field]: errorText(submitError, t("servers.editDialog.error")),
        });
        return;
      }
      const message = isNotFound(submitError)
        ? t("servers.editDialog.notReady404")
        : errorText(submitError, t("servers.editDialog.error"));
      setError(message);
      toast.error(message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && updateServer.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-4 pr-12 sm:px-6">
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <SlidersHorizontalIcon className="size-3.5" />
            </span>
            {t("servers.editDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("servers.editDialog.desc", { name: server.name })}
          </DialogDescription>
        </DialogHeader>

        <form
          id="server-settings-form"
          className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
          onSubmit={handleSubmit}
        >
          <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              {t("servers.editDialog.currentVersion")}
            </span>
            <span className="font-mono text-foreground">
              {displayAgentVersion(server.agent_version) ||
                t("servers.upgradeDialog.notReported")}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-country" className="text-sm">
              {t("servers.country")}
            </Label>
            <CountrySelect
              value={countryCode}
              onChange={setCountryCode}
              disabled={updateServer.isPending}
            />
            <p
              id="server-country-desc"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              {t("servers.countryHint")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-group" className="text-sm">
              {t("servers.group")}
            </Label>
            <Input
              id="server-group"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder={t("servers.groupPlaceholder")}
              maxLength={GROUP_NAME_MAX_LENGTH}
              autoComplete="off"
              disabled={updateServer.isPending}
            />
          </div>

          <NicField
            id="server-edit-nic"
            value={nicName}
            interfaces={server.interfaces}
            state={nic}
            onChange={setNicName}
            disabled={updateServer.isPending}
          />

          <PortPolicyFields
            idPrefix="server-edit-port"
            start={portStart}
            end={portEnd}
            allow={portAllow}
            onStartChange={setPortStart}
            onEndChange={setPortEnd}
            onAllowChange={setPortAllow}
            disabled={updateServer.isPending}
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-internal-address" className="text-sm">
              {t("servers.portPolicy.internalAddress")}
            </Label>
            <Input
              id="server-internal-address"
              value={internalAddress}
              onChange={(event) => setInternalAddress(event.target.value)}
              placeholder={t(
                "servers.portPolicy.internalAddressPlaceholder",
              )}
              autoComplete="off"
              disabled={updateServer.isPending}
              className="font-mono"
            />
          </div>

          <BillingFields
            idPrefix="server-edit-billing"
            value={billing}
            onChange={updateBilling}
            errors={billingErrors}
            disabled={updateServer.isPending}
          />

          <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="allow-agent-upgrade" className="text-sm">
                {t("servers.editDialog.allow")}
              </Label>
              <p
                id="allow-agent-upgrade-desc"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {t("servers.editDialog.allowDesc")}
              </p>
            </div>
            <Switch
              id="allow-agent-upgrade"
              checked={allowUpgrade}
              onCheckedChange={setAllowUpgrade}
              disabled={updateServer.isPending}
              aria-describedby="allow-agent-upgrade-desc"
            />
          </div>

          {error ? (
            <p
              role="alert"
              aria-live="polite"
              className="text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
          </div>
        </form>

        <DialogFooter className="mx-0 mb-0 rounded-none border-border px-4 py-3 sm:px-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateServer.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="server-settings-form"
            disabled={updateServer.isPending}
          >
            {updateServer.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : null}
            {updateServer.isPending
              ? t("common.saving")
              : t("servers.editDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
