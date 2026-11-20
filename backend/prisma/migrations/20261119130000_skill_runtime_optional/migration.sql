-- Skill 运行时允许"未声明"（2026-11-19）
--
-- 第三方 SKILL.md 普遍不写 `requires.runtime`；此前缺省强制 INLINE + 带脚本直接拒绝，
-- 导致外部 Skill 基本导不进来。放宽后：包内没声明且不带脚本 ⇒ NULL（管理面显示"未声明"，
-- 执行 / manifest 侧按 INLINE 处理）；带脚本 ⇒ 一律 SANDBOX。
-- 已有行保持原值，不受影响。

ALTER TABLE "skills" ALTER COLUMN "runtime" DROP NOT NULL;