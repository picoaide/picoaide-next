-- 0026: mcp_servers.name 唯一约束(审计 A5-M9)。
--
-- 此前同名插件可重复上架:管理列表与凭证下载审计(mcp_name)无法区分同名行,
-- 创建冲突返回 INTERNAL 而非 VALIDATION。本迁移:
--   1. 把指向重复行的 mcp_grants / mcp_config_downloads 引用迁移到同名保留行
--      (每名取最小 id,审计记录不丢);
--   2. 删除重复行;
--   3. 建唯一索引(重复已清,保证创建成功)。

-- 1a. grants 引用迁移(目标主键冲突时 INSERT OR IGNORE 防重)
INSERT OR IGNORE INTO mcp_grants (mcp_id, grantee_type, grantee)
SELECT keep.id, g.grantee_type, g.grantee
FROM mcp_servers keep
JOIN mcp_servers dup ON dup.name = keep.name AND dup.id != keep.id AND keep.id < dup.id
JOIN mcp_grants g ON g.mcp_id = dup.id;

-- 1b. downloads 引用迁移(审计记录重指向保留行)
UPDATE mcp_config_downloads
SET mcp_id = (SELECT MIN(id) FROM mcp_servers WHERE name = (
  SELECT name FROM mcp_servers WHERE id = mcp_config_downloads.mcp_id))
WHERE mcp_id IN (
  SELECT id FROM mcp_servers s
  WHERE s.id > (SELECT MIN(id) FROM mcp_servers WHERE name = s.name));

-- 2. 删除重复行(保留每名最小 id 的一行)
DELETE FROM mcp_servers
WHERE id > (SELECT MIN(id) FROM mcp_servers WHERE name = mcp_servers.name);

-- 3. 唯一索引(此后 AddMCPServer 重名触发 UNIQUE → ErrDuplicate → VALIDATION)
CREATE UNIQUE INDEX idx_mcp_servers_name ON mcp_servers(name);
