-- P1-14 沙箱多机部署：Sandbox 归属列 instance_id
--
-- 依据：`docs/子方案/沙箱多机部署.md` §三 2（账本归属列）+ §七（迁移与回填）。
-- 三步（加**可空**列 → 回填 → 置 NOT NULL + 索引），避免对存量数据直接加 NOT NULL 的构建期风险；
-- 回填值 `default` = 约定默认实例 id（§十 3 定案）：存量行（单机时代）由"约定默认实例"接管，
-- 其余实例的对账查询 `WHERE instance_id = self` **不会匹配 `default`** ⇒ 过渡期不误杀，也丢不了。
ALTER TABLE "sandboxes" ADD COLUMN "instance_id" VARCHAR(120);

UPDATE "sandboxes" SET "instance_id" = 'default' WHERE "instance_id" IS NULL;

ALTER TABLE "sandboxes" ALTER COLUMN "instance_id" SET NOT NULL;

-- 归属过滤的扫描键：三处对账（启动对账 / 孤儿回收 / 空闲回收）都带 instance_id = ?
CREATE INDEX "sandboxes_instance_id_status_idx" ON "sandboxes"("instance_id", "status");
