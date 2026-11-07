-- 「内联 Xray」从来没实现过：xray_mode 只是存了个字段，Agent 两种模式行为完全一样。
-- 与其留一个骗人的选项，不如把历史数据归一到外置，并在 API 层拒绝再写入 embedded。
UPDATE servers SET xray_mode = 'external' WHERE xray_mode = 'embedded';
