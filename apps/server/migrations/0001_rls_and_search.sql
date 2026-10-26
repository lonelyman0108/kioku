-- 内容表的行级安全：每个事务用 set_config('app.space_id', ..., true) 声明当前空间。
-- 没设置时 nullif 得到 NULL，比较结果为假，查询返回空集、写入被拒，默认关闭而不是默认放行。
-- FORCE 让表的属主（应用角色本身）也受策略约束；超级用户和 BYPASSRLS 角色仍会绕过，服务启动时拒绝这两种角色。
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['personas', 'apps', 'subjects', 'subject_identities', 'memories', 'memory_glossary', 'memory_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY space_isolation ON %I USING (space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid) WITH CHECK (space_id = nullif(current_setting(''app.space_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
-- 中文全文检索配置：zhparser 扩展由数据库初始化脚本以超级用户安装，这里只建配置
CREATE TEXT SEARCH CONFIGURATION kioku_zh (PARSER = zhparser);
--> statement-breakpoint
ALTER TEXT SEARCH CONFIGURATION kioku_zh ADD MAPPING FOR n, v, a, i, e, l, j WITH simple;
