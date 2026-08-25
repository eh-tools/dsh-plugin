/**
 * db-console 纯函数层测试(node:test, 无外部依赖)。
 * 运行: node plugins/db-console/tests/pg.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
    validateConnectionUrl,
    withApplicationName,
    maskConnectionUrl,
    describeConnectionUrl,
    statementKind,
    groupSchemaTree,
    truncateRows,
    resolveScopeKey,
} from '../lib/pg.js';

// ---- validateConnectionUrl ----

test('validate: 合法链接原样规范化返回', () => {
    const out = validateConnectionUrl('postgres://u:p%40ss@127.0.0.1:5432/mydb?sslmode=require');
    assert.match(out, /^postgres:\/\/u:p%40ss@127\.0\.0\.1:5432\/mydb/);
});

test('validate: postgresql:// 协议也接受', () => {
    const out = validateConnectionUrl('postgresql://u@localhost/db');
    assert.ok(out.startsWith('postgresql://'));
});

test('validate: 拒绝空串/非 URL', () => {
    assert.throws(() => validateConnectionUrl(''), /为空/);
    assert.throws(() => validateConnectionUrl('not a url'), /合法的 URL/);
    assert.throws(() => validateConnectionUrl(null), /为空|非法/);
});

test('validate: 拒绝非 pg 协议(mysql://)', () => {
    assert.throws(() => validateConnectionUrl('mysql://u@h/db'), /postgres/);
});

test('validate: 拒绝缺 host; 允许省略库名但拒绝空库名段', () => {
    assert.throws(() => validateConnectionUrl('postgres:///db'), /主机名/);
    assert.doesNotThrow(() => validateConnectionUrl('postgres://u@h'));
    assert.throws(() => validateConnectionUrl('postgres://u@h/'), /数据库名为空/);
});

// ---- withApplicationName ----

test('withApplicationName: 追加且幂等', () => {
    const once = withApplicationName('postgres://u@h/db', 'dsh-db-console');
    assert.equal(once, withApplicationName(once, 'dsh-db-console'));
    assert.match(once, /application_name=dsh-db-console/);
    // 已有值不覆盖
    const keep = withApplicationName('postgres://u@h/db?application_name=mine', 'x');
    assert.match(keep, /application_name=mine/);
});

// ---- maskConnectionUrl / describeConnectionUrl ----

test('mask: 密码打码, 其余保留', () => {
    const masked = maskConnectionUrl('postgres://alice:secret@db.local:5433/prod');
    assert.ok(!masked.includes('secret'));
    assert.ok(masked.includes('•••'));
    assert.ok(masked.includes('alice'));
    assert.ok(masked.includes('@db.local:5433/prod'));
});

test('mask: 无密码原样; 非法输入给固定掩码', () => {
    assert.equal(
        maskConnectionUrl('postgres://alice@db.local/prod'),
        'postgres://alice@db.local/prod',
    );
    assert.equal(maskConnectionUrl('garbage'), 'postgres://•••');
});

test('describe: user@host:port/db 摘要', () => {
    assert.equal(
        describeConnectionUrl('postgres://bob:pw@example.com:6543/analytics'),
        'bob@example.com:6543/analytics',
    );
    assert.equal(describeConnectionUrl('???'), null);
});

// ---- statementKind ----

test('kind: 查询类语句 → rows', () => {
    for (const sql of [
        'SELECT 1',
        'select * from t where x = 1',
        '  -- c\nEXPLAIN ANALYZE SELECT 1',
        'WITH x AS (SELECT 1) SELECT * FROM x',
        'SHOW search_path',
        'TABLE users',
        'VALUES (1),(2)',
    ]) {
        assert.equal(statementKind(sql), 'rows', sql);
    }
});

test('kind: 命令类语句 → ok', () => {
    for (const sql of [
        'INSERT INTO t VALUES (1)',
        'UPDATE t SET a = 1',
        'DELETE FROM t',
        'CREATE TABLE t(a int)',
        'BEGIN',
        '',
    ]) {
        assert.equal(statementKind(sql), 'ok', sql);
    }
});

test('kind: WITH 按顶层主句动词判别', () => {
    // 主句 SELECT(即使 CTE 体含写)→ 数据以行集返回, 判 rows
    assert.equal(
        statementKind('WITH del AS (DELETE FROM t RETURNING *) SELECT * FROM del'),
        'rows',
    );
    // 主句 UPDATE → ok
    assert.equal(statementKind('WITH x AS (SELECT 1) UPDATE y SET a = 1 FROM x'), 'ok');
});

// ---- groupSchemaTree ----

test('schema 树: 分组、public 置顶、表名字典序', () => {
    const tree = groupSchemaTree([
        { table_schema: 'app', table_name: 'zebra', column_name: 'id', data_type: 'integer' },
        { table_schema: 'public', table_name: 'users', column_name: 'id', data_type: 'bigint' },
        { table_schema: 'public', table_name: 'users', column_name: 'name', data_type: 'text' },
        { table_schema: 'public', table_name: 'apple', column_name: 'id', data_type: 'integer' },
    ]);
    assert.deepEqual(
        tree.map((s) => s.name),
        ['public', 'app'],
    );
    const pub = tree[0];
    assert.deepEqual(
        pub.tables.map((t) => t.name),
        ['apple', 'users'],
    );
    assert.deepEqual(
        pub.tables[1].columns.map((c) => `${c.name}:${c.type}`),
        ['id:bigint', 'name:text'],
    );
});

test('schema 树: 空/缺字段输入安全', () => {
    assert.deepEqual(groupSchemaTree([]), []);
    assert.deepEqual(groupSchemaTree(null), []);
});

// ---- truncateRows ----

test('truncate: 未超限不截断; 超限截断并带 total', () => {
    const small = truncateRows([1, 2, 3], 5);
    assert.equal(small.truncated, false);
    assert.deepEqual(small.rows, [1, 2, 3]);
    const big = truncateRows([1, 2, 3], 2);
    assert.equal(big.truncated, true);
    assert.deepEqual(big.rows, [1, 2]);
    assert.equal(big.total, 3);
});

// ---- resolveScopeKey ----

function fakeFs(tree) {
    return {
        async stat(p) {
            if (tree.has(p)) return {};
            throw new Error('enoent');
        },
        async realpath(p) {
            return path.resolve(p);
        },
    };
}

test('scopeKey: 向上归并到 .git 所在目录', async () => {
    const root = path.resolve('/repo');
    const tree = new Map([[path.join(root, '.git'), {}]]);
    const out = await resolveScopeKey(path.join(root, 'a', 'b'), fakeFs(tree));
    assert.equal(out, root);
});

test('scopeKey: 无 .git 退化为起点自身(realpath)', async () => {
    const start = path.resolve('/plain/dir');
    const out = await resolveScopeKey(start, fakeFs(new Map()));
    assert.equal(out, start);
});
