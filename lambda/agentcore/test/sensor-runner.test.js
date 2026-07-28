import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSensorRunner, __test } from '../sensor-runner.js';

const { globToRegExp, resultFromScript, tailDiagnostic, scopeToChangedFiles } = __test;

describe('globToRegExp', () => {
  it('matches a brace-alternation code glob', () => {
    const re = globToRegExp('**/*.{ts,tsx}');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/a.tsx')).toBe(true);
    expect(re.test('src/a.js')).toBe(false);
  });
  it('matches an aidlc-docs path glob', () => {
    const re = globToRegExp('**/aidlc-docs/**');
    expect(re.test('aidlc-docs/x/y.md')).toBe(true);
    expect(re.test('src/aidlc-docs/z.md')).toBe(true);
    expect(re.test('src/other.md')).toBe(false);
  });
});

describe('resultFromScript', () => {
  it('reads the stdout JSON pass field over the exit code', () => {
    expect(resultFromScript({ exitCode: 0, stdout: '{"pass":false}' }).result).toBe('FAIL');
    expect(resultFromScript({ exitCode: 0, stdout: '{"pass":true}' }).result).toBe('PASS');
  });
  it('falls back to the exit code without JSON', () => {
    expect(resultFromScript({ exitCode: 2, stdout: '' }).result).toBe('INCONCLUSIVE');
  });

  it('reports 127 as tool-unavailable INCONCLUSIVE, not FAIL', () => {
    const r = resultFromScript({
      exitCode: 127,
      stdout: '',
      stderr: 'tsc-unavailable\n',
      runtime: 'bun',
    });
    expect(r.result).toBe('INCONCLUSIVE');
    expect(r.detail).toMatchObject({ reason: 'tool-unavailable', exitCode: 127 });
    expect(r.detail.stderr).toBe('tsc-unavailable');
  });

  it('reports a non-zero bun/node exit with no verdict as script-error, not FAIL', () => {
    // This is the regression: a missing tsconfig (exit 1) or a tsc config-load
    // failure used to surface as FAIL for every file, indistinguishable from
    // genuine type errors.
    for (const exitCode of [1, 3, 66]) {
      const r = resultFromScript({
        exitCode,
        stdout: '',
        stderr: 'no-tsconfig-found',
        runtime: 'bun',
      });
      expect(r.result).toBe('INCONCLUSIVE');
      expect(r.detail).toMatchObject({ reason: 'script-error', exitCode });
    }
  });

  it('keeps the exit-code convention for sh sensors', () => {
    // A shell sensor has no stdout-JSON contract, so non-zero legitimately means
    // FAIL. Only bun/node carry their verdict on stdout.
    const r = resultFromScript({ exitCode: 1, stdout: '', stderr: 'boom', runtime: 'sh' });
    expect(r.result).toBe('FAIL');
    expect(r.detail).toMatchObject({ exitCode: 1, stderr: 'boom' });
  });

  it('still BLOCKS on a spawn error or timeout (null exit)', () => {
    expect(resultFromScript({ exitCode: null, stdout: '', runtime: 'bun' }).result).toBe('BLOCKED');
  });

  it('truncates a long stderr from the tail and keeps the real error', () => {
    const stderr = `${'banner\n'.repeat(500)}THE ACTUAL ERROR`;
    const r = resultFromScript({ exitCode: 1, stdout: '', stderr, runtime: 'bun' });
    expect(r.detail.stderr).toContain('THE ACTUAL ERROR');
    expect(r.detail.stderr.length).toBeLessThanOrEqual(501);
  });
});

describe('scopeToChangedFiles', () => {
  const globbed = ['packages/api/src/app.ts', 'packages/api/vitest.config.ts', 'web/src/App.tsx'];

  it('does not scope when provenance is unknown (null)', () => {
    // Never silently skip checks because we could not determine what changed.
    expect(scopeToChangedFiles(globbed, null)).toEqual(globbed);
    expect(scopeToChangedFiles(globbed, undefined)).toEqual(globbed);
  });

  it('returns nothing when the stage changed nothing on disk', () => {
    expect(scopeToChangedFiles(globbed, [])).toEqual([]);
  });

  it('keeps only the changed files on an exact (single-repo) match', () => {
    expect(scopeToChangedFiles(globbed, ['packages/api/src/app.ts'])).toEqual([
      'packages/api/src/app.ts',
    ]);
  });

  it('matches repo-relative paths nested under a multi-repo workspace', () => {
    // listFiles yields workspace-relative paths; the engine reports paths
    // relative to each repo dir, which is nested when multi is true.
    const multi = ['acme/shop/packages/api/src/app.ts', 'acme/other/web/src/App.tsx'];
    expect(scopeToChangedFiles(multi, ['packages/api/src/app.ts'])).toEqual([
      'acme/shop/packages/api/src/app.ts',
    ]);
  });

  it('does not treat a partial path segment as a match', () => {
    // 'app.ts' must not match 'src/myapp.ts' — the suffix check is anchored on /.
    expect(scopeToChangedFiles(['src/myapp.ts'], ['app.ts'])).toEqual([]);
  });
});

describe('tailDiagnostic', () => {
  it('returns null for empty or whitespace stderr', () => {
    expect(tailDiagnostic('')).toBeNull();
    expect(tailDiagnostic('   \n')).toBeNull();
    expect(tailDiagnostic(undefined)).toBeNull();
  });
});

// A fake graph-writer returning canned artifact rows by type.
const fakeGraph = (byType) => ({
  lookupArtifacts: async ({ artifactType }) => byType[artifactType] ?? [],
});

describe('runStageSensors — graph kind', () => {
  it('passes required-sections when produced content has >= 2 H2s', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ requirements: [{ id: 'r1', content: '## A\n## B\n' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'requirements' }],
      stageId: 'requirements-analysis',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'graph', result: 'PASS', held: false });
  });

  it('a blocking required-sections that fails marks the verdict held', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ requirements: [{ id: 'r1', content: '## only one' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'blocking' }],
      outputArtifacts: [{ artifact: 'requirements' }],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ result: 'FAIL', held: true });
  });

  it('upstream-coverage flags an unreferenced consume', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({ design: [{ id: 'd1', content: 'mentions requirements only' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'upstream-coverage', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [{ artifact: 'requirements' }, { artifact: 'security-design' }],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('FAIL');
    expect(verdicts[0].detail.artifacts[0].unreferenced).toEqual(['security-design']);
  });

  it('upstream-coverage skips expectedAbsent consumes (no false FAIL in lean scopes)', async () => {
    // `unit-of-work` is never produced in this scope (producer out of scope) —
    // the output can't legitimately reference it, so it must not be threaded
    // into the coverage check. Only the present input counts.
    const runner = createSensorRunner({
      graph: fakeGraph({ design: [{ id: 'd1', content: 'derived from requirements' }] }),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'upstream-coverage', severity: 'advisory' }],
      outputArtifacts: [{ artifact: 'design' }],
      inputArtifacts: [
        { artifact: 'requirements', required: true },
        { artifact: 'unit-of-work', required: true, expectedAbsent: true },
      ],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('PASS');
  });

  it('graph-coverage runs intent-wide off getCoverage (not per produced artifact)', async () => {
    const runner = createSensorRunner({
      graph: {
        ...fakeGraph({}),
        getCoverage: async () => ({
          counts: { requirements: 1, stories: 1, mappings: 1, components: 0 },
          uncoveredRequirements: [],
          uncoveredMustHave: [{ slug: 'req-pay' }],
          unmappedStories: [],
          unknownReferences: [],
          componentCycles: [],
        }),
      },
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'graph-coverage', severity: 'advisory' }],
      // No produced artifacts needed — the report is intent-wide.
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'graph', result: 'FAIL', held: false });
    expect(verdicts[0].detail.uncovered_must_have).toEqual(['req-pay']);
  });

  it('graph-coverage degrades to INCONCLUSIVE when the writer lacks getCoverage', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({}),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'graph-coverage', severity: 'advisory' }],
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
  });

  it('INCONCLUSIVE when the stage produced no artifacts', async () => {
    const runner = createSensorRunner({
      graph: fakeGraph({}),
      loadBlockScript: async () => '',
      workspaceDir: null,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [{ sensorId: 'required-sections', severity: 'advisory' }],
      outputArtifacts: [],
      stageId: 's',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
  });
});

describe('runStageSensors — script kind', () => {
  let ws;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'sensor-ws-'));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  // A fake spawn that emits a JSON verdict on stdout and exits 0.
  const fakeSpawn =
    (stdout, code = 0) =>
    () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      }, 0);
      return child;
    };

  it('INCONCLUSIVE when no workspace file matches the glob', async () => {
    await writeFile(path.join(ws, 'README.md'), '# hi');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'console.log("{}")',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
    expect(verdicts[0].detail.reason).toBe('no files match');
  });

  it('spawns the materialized script per matching file and reads its verdict', async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const x = 1;');
    let scriptWritten = '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => {
        scriptWritten = 'SENSOR_SCRIPT_BODY';
        return scriptWritten;
      },
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun <runtime-managed>/tools/aidlc-sensor-linter.ts',
          matches: '**/*.{ts,js}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'script', result: 'PASS', held: false });
    expect(verdicts[0].detail.files[0].file).toBe('src/a.ts');
  });

  it('a harness failure across every file is INCONCLUSIVE, not a false FAIL', async () => {
    // Reproduces the observed production shape: every matching file exits
    // non-zero with nothing on stdout (broken tsconfig / unresolvable tool).
    // Previously each file recorded FAIL with detail:null and the sensor
    // reported FAIL — indistinguishable from real type errors.
    await mkdir(path.join(ws, 'packages', 'api'), { recursive: true });
    await writeFile(path.join(ws, 'packages', 'api', 'app.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'packages', 'api', 'vitest.config.ts'), 'export default {};');
    const spawnWithStderr = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('error TS18003: No inputs were found'));
        child.emit('close', 1);
      }, 0);
      return child;
    };
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'SENSOR_SCRIPT_BODY',
      workspaceDir: ws,
      spawnFn: spawnWithStderr,
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'type-check',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.{ts,tsx}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'infrastructure-design',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
    expect(verdicts[0].held).toBe(false);
    // Every file carries the diagnosable exit code + stderr now.
    for (const f of verdicts[0].detail.files) {
      expect(f.result).toBe('INCONCLUSIVE');
      expect(f.exitCode).toBe(1);
      expect(f.stderr).toContain('TS18003');
      expect(f.detail.reason).toBe('script-error');
    }
  });

  it('a real code defect (exit 0, pass:false) is still FAIL', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'BODY',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":false,"errors":[{"file":"a.ts"}],"findings_count":1}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'type-check',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0].result).toBe('FAIL');
    expect(verdicts[0].detail.files[0].detail.findings_count).toBe(1);
  });

  it('a design stage is not graded on a previous stage source (changedFiles empty)', async () => {
    // The reported bug: infrastructure-design writes methodology artifacts to
    // Neptune and nothing to disk, yet the glob matched ~40 .ts files left by an
    // earlier code-generation stage and spawned the type-checker on each.
    await mkdir(path.join(ws, 'packages', 'api', 'src'), { recursive: true });
    await writeFile(path.join(ws, 'packages', 'api', 'src', 'app.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'packages', 'api', 'vitest.config.ts'), 'export default {};');
    let spawns = 0;
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'BODY',
      workspaceDir: ws,
      changedFiles: [],
      spawnFn: (...a) => {
        spawns += 1;
        return fakeSpawn('{"pass":true}')(...a);
      },
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'type-check',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.{ts,tsx}',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'infrastructure-design',
    });
    expect(verdicts[0].result).toBe('INCONCLUSIVE');
    expect(verdicts[0].detail.reason).toBe('no changed files match');
    expect(verdicts[0].detail.globbed).toBe(2);
    expect(spawns).toBe(0);
  });

  it('a code stage checks only the files it changed', async () => {
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'touched.ts'), 'export const a = 1;');
    await writeFile(path.join(ws, 'src', 'untouched.ts'), 'export const b = 2;');
    const inspected = [];
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => 'BODY',
      workspaceDir: ws,
      changedFiles: ['src/touched.ts'],
      spawnFn: (file, args, opts) => {
        inspected.push(args[args.indexOf('--file-path') + 1]);
        return fakeSpawn('{"pass":true}')(file, args, opts);
      },
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'type-check',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0].result).toBe('PASS');
    expect(inspected).toEqual(['src/touched.ts']);
  });

  it('BLOCKED when a script sensor has no script bytes', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'x');
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript: async () => '',
      workspaceDir: ws,
      spawnFn: fakeSpawn('{}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'blocking',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
        },
      ],
      stageId: 's',
    });
    expect(verdicts[0]).toMatchObject({ result: 'BLOCKED', held: true });
  });

  // Regression for the plan→runner scriptRef contract. The PROD loadBlockScript
  // reads sensor.scriptRef.s3Key from S3; here we mimic that (return bytes if
  // the sensor carries a scriptRef) instead of the argument-ignoring stub the
  // other tests use. A plan sensor that carries its scriptRef must run; one
  // whose scriptRef was stripped must BLOCK. This is the shape that
  // v2-execution-plan.resolveSensors now guarantees.
  it('runs a script sensor whose plan object carries a scriptRef (prod loader semantics)', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    // Mirrors block-loader.loadBlockScript: '' when there is no scriptRef.
    const loadBlockScript = async (sensor) =>
      sensor?.scriptRef?.s3Key ? 'SENSOR_SCRIPT_BODY' : '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript,
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          scriptRef: { s3Key: 'blocks/scripts/sha256/abc123' },
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ kind: 'script', result: 'PASS' });
  });

  it('BLOCKS a script sensor whose plan object lost its scriptRef (prod loader semantics)', async () => {
    await writeFile(path.join(ws, 'a.ts'), 'export const x = 1;');
    const loadBlockScript = async (sensor) =>
      sensor?.scriptRef?.s3Key ? 'SENSOR_SCRIPT_BODY' : '';
    const runner = createSensorRunner({
      graph: null,
      loadBlockScript,
      workspaceDir: ws,
      spawnFn: fakeSpawn('{"pass":true,"errorCount":0}'),
    });
    const verdicts = await runner.runStageSensors({
      sensors: [
        {
          sensorId: 'linter',
          severity: 'advisory',
          runtime: 'bun',
          command: 'bun x.ts',
          matches: '**/*.ts',
          timeoutSeconds: 5,
          // scriptRef intentionally absent — the pre-fix regression shape.
        },
      ],
      stageId: 'code-generation',
    });
    expect(verdicts[0]).toMatchObject({ result: 'BLOCKED' });
    expect(verdicts[0].detail.error).toBe('sensor has no script');
  });
});
