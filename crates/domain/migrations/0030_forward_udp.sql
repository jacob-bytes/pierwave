-- native 引擎支持 UDP：规则可以要求「在同一端口号上再监听一个 UDP socket」。
--
-- 只追加列、不改历史文件：旧数据默认 0（只监听 TCP），行为与升级前完全一致。
-- 为什么 TCP/UDP 共用一列开关而不是两张表：一条游戏规则通常需要同端口的
-- TCP 与 UDP 同时可达（登录走 TCP、对局走 UDP），拆成两条规则会多占一个端口，
-- 也会让「只开 UDP」这种需求在端口冲突校验里互相打架。
--
-- realm 引擎不看这一列：它生成的配置固定 use_udp = true，总是转发 UDP。
ALTER TABLE forwards ADD COLUMN udp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chains   ADD COLUMN udp INTEGER NOT NULL DEFAULT 0;
