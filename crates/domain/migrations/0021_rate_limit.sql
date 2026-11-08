-- P11 限速：A 节点级精确限速（Agent 用 tc），C 套餐近似限速（Xray bufferSize）。
--
-- NULL / 0 都表示「不限」：历史行迁移后保持 NULL，接口层统一把 0 当成不限，
-- 这样旧数据不需要回填，也不会被误读成「限速 0 kbps」。
--
-- nodes.bandwidth_kbps 由 Agent 按节点端口下 u32 filter 到 HTB class，
-- 是真正的 kbps 上限；packages.speed_limit_kbps 只能映射成 Xray 的
-- policy.levels.N.bufferSize，是近似值（见 xray.rs 的换算注释）。
ALTER TABLE nodes ADD COLUMN bandwidth_kbps INTEGER;
ALTER TABLE packages ADD COLUMN speed_limit_kbps INTEGER;
