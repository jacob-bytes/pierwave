-- 迁移 0050：把「发现新版本时通知」并入 alert_events 事件列表。
--
-- 通知路径从此只读 alert_events（唯一事实来源）；`update_check_notify` 键保留
-- 兼容（旧前端仍可读写），本迁移只把它的历史值一次性映射到新事件
-- `update_available`，让升级前后的行为保持一致：
--
--   * 其它事件原样保留（旧 `alert_events` 里有什么就还有什么）；
--   * `update_available` 出现 ⇔ 旧开关不是显式关闭（缺省 = 开启）；
--   * 从未保存过事件列表时不必写库：读取侧的缺省值已经包含 `update_available`；
--     但如果旧开关是显式关闭，就补一条不含新事件的旧默认值，把「关掉」延续下来；
--   * 旧开关显式关闭 + 事件列表为空 → 仍然为空（全部关闭）。
--
-- English: the release notification now lives in `alert_events`. The legacy
-- `update_check_notify` key stays for API compatibility and is only read by
-- this one-time migration. The migration keeps every existing event and adds
-- `update_available` exactly when the legacy switch was not explicitly off
-- (missing = on), which preserves the old behaviour for every stored state.
-- An explicitly empty list with the switch off stays empty; with the switch on
-- it becomes the single `update_available` event, because that is the one
-- notification the old configuration still delivered.
UPDATE settings
SET value = CASE
        WHEN trim(value) = '' THEN 'update_available'
        ELSE rtrim(value, ',') || ',update_available'
    END
WHERE key = 'alert_events'
  AND instr(',' || value || ',', ',update_available,') = 0
  AND lower(trim(coalesce(
        (SELECT legacy.value FROM settings AS legacy WHERE legacy.key = 'update_check_notify'),
        '1'
      ))) NOT IN ('0', 'false');

INSERT INTO settings (key, value)
SELECT 'alert_events', 'server_offline,user_exhausted,chain_degraded'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'alert_events')
  AND EXISTS (
      SELECT 1 FROM settings
      WHERE key = 'update_check_notify'
        AND lower(trim(value)) IN ('0', 'false')
  );
