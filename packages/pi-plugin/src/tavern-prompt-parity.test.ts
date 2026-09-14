import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
  materializeGameBuddyAuthoredStableCatalog,
  validateGameBuddyAuthoredStableCatalog,
  type GameBuddyAuthoredSourceKind,
  type GameBuddyAuthoredStableCatalog,
  type GameBuddyAuthoredStableSource,
  type GameBuddyChatContextScope,
} from "./gamebuddy-stable-context-source";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
      : JSON.stringify(value);

/**
 * Convenience helper rendering the stable M0 context block from an authored catalog.
 */
export function renderGameBuddyStableContextBlock(
  catalog: unknown,
  scope: GameBuddyChatContextScope,
): string {
  return materializeGameBuddyAuthoredStableCatalog(catalog, scope).renderedBlock;
}

function buildCatalog(
  scope: GameBuddyChatContextScope,
  stableSources: readonly GameBuddyAuthoredStableSource[],
  volatileSources?: readonly GameBuddyAuthoredVolatileSource[],
): GameBuddyAuthoredStableCatalog {
  const body = volatileSources !== undefined
    ? {
        version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
        scope,
        stableSources,
        volatileSources,
      }
    : {
        version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
        scope,
        stableSources,
      };
  return {
    ...body,
    canonicalHash: sha256(canonical(body)),
  } as unknown as GameBuddyAuthoredStableCatalog;
}

describe("M0 byte parity and deterministic regression (Lane 3)", () => {
  const standardScope: GameBuddyChatContextScope = Object.freeze({
    continuityId: "cont-fixed-001",
    sessionId: "sess-fixed-002",
    surface: "tavern" as const,
    threadId: "thread-fixed-003",
    profile: Object.freeze({
      profileId: "prof-fixed-004",
      revision: 1,
      canonicalHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    }),
  });

  const personaContent = "You are Lyra, an empathetic scholar in the Stardrop Saloon.";
  const scenarioContent = "Rain patters on the tavern roof while patrons warm themselves by the hearth.";
  const lorebookContent = "Saloon Rule: Gus offers hospitality to all who respect the peace.";

  const standardSources: readonly GameBuddyAuthoredStableSource[] = Object.freeze([
    Object.freeze({
      sourceId: "persona-lyra",
      kind: "persona" as GameBuddyAuthoredSourceKind,
      revision: "rev-p-001",
      canonicalHash: sha256(personaContent),
      content: personaContent,
      budgetTokens: 120,
      totalOrderKey: "0010",
      provenance: "gamebuddy://profile/lyra",
    }),
    Object.freeze({
      sourceId: "scenario-rainy-saloon",
      kind: "scenario" as GameBuddyAuthoredSourceKind,
      revision: "rev-s-001",
      canonicalHash: sha256(scenarioContent),
      content: scenarioContent,
      budgetTokens: 180,
      totalOrderKey: "0020",
      provenance: "gamebuddy://scenario/rainy-saloon",
    }),
    Object.freeze({
      sourceId: "lore-saloon-rules",
      kind: "lorebook_constant" as GameBuddyAuthoredSourceKind,
      revision: "rev-l-001",
      canonicalHash: sha256(lorebookContent),
      content: lorebookContent,
      budgetTokens: 90,
      totalOrderKey: "0030",
      provenance: "gamebuddy://lorebook/saloon-rules",
    }),
  ]);

  test("用例 1：M0 XML 渲染字节保真断言（Bitwise Parity）", () => {
    const catalog = buildCatalog(standardScope, standardSources);

    // 验证 catalog 校验及 canonicalHash 计算正常
    const validated = validateGameBuddyAuthoredStableCatalog(catalog, standardScope);
    expect(validated.canonicalHash).toBe(catalog.canonicalHash);

    // 调用 renderGameBuddyStableContextBlock 渲染 M0 块
    const renderedBlock = renderGameBuddyStableContextBlock(catalog, standardScope);

    // 构造预期的精准 XML 字符串（遵循属性排序、单换行符与结构规范）
    const expectedXml = [
      `<gamebuddy-authored-context version="v2" continuity-id="cont-fixed-001" session-id="sess-fixed-002" thread-id="thread-fixed-003" canonical-hash="${catalog.canonicalHash}">`,
      `<gamebuddy-authored-source kind="persona" source-id="persona-lyra" revision="rev-p-001" canonical-hash="${standardSources[0].canonicalHash}">`,
      personaContent,
      `</gamebuddy-authored-source>`,
      `<gamebuddy-authored-source kind="scenario" source-id="scenario-rainy-saloon" revision="rev-s-001" canonical-hash="${standardSources[1].canonicalHash}">`,
      scenarioContent,
      `</gamebuddy-authored-source>`,
      `<gamebuddy-authored-source kind="lorebook_constant" source-id="lore-saloon-rules" revision="rev-l-001" canonical-hash="${standardSources[2].canonicalHash}">`,
      lorebookContent,
      `</gamebuddy-authored-source>`,
      `</gamebuddy-authored-context>`,
    ].join("\n");

    // 1. 严格逐字节比对 XML 字符串
    expect(renderedBlock).toBe(expectedXml);

    // 2. 断言 XML 顶层标签属性顺序严格为：version, continuity-id, session-id, thread-id, canonical-hash
    const rootTagMatch = renderedBlock.match(/^<gamebuddy-authored-context ([^>]+)>/);
    expect(rootTagMatch).not.toBeNull();
    const rootAttrs = rootTagMatch![1];
    const expectedRootAttrPattern = /^version="v2" continuity-id="cont-fixed-001" session-id="sess-fixed-002" thread-id="thread-fixed-003" canonical-hash="[0-9a-f]{64}"$/;
    expect(expectedRootAttrPattern.test(rootAttrs)).toBe(true);

    // 3. 断言子标签属性顺序严格为：kind, source-id, revision, canonical-hash
    const sourceTagMatches = Array.from(renderedBlock.matchAll(/<gamebuddy-authored-source ([^>]+)>/g));
    expect(sourceTagMatches.length).toBe(3);
    for (const match of sourceTagMatches) {
      const attrs = match[1];
      expect(/^kind="[^"]+" source-id="[^"]+" revision="[^"]+" canonical-hash="[0-9a-f]{64}"$/.test(attrs)).toBe(true);
    }

    // 4. 断言换行符完全符合规范（纯 Unix \n，无 \r\n，换行位置确定）
    expect(renderedBlock.includes("\r")).toBe(false);
    expect(renderedBlock.split("\n").length).toBe(11);

    // 5. 录制并校验生成的 SHA-256 摘要（Bitwise Parity 固定值）
    const EXPECTED_M0_PARITY_SHA256 = "b755814c3884067d64a8563386f54f698db6cc644a41e5015e5c05b5416b857f";
    const renderedSha256 = sha256(renderedBlock);
    const expectedSha256 = sha256(expectedXml);
    expect(renderedSha256).toBe(EXPECTED_M0_PARITY_SHA256);
    expect(renderedSha256).toBe(expectedSha256);
  });

  test("用例 2：全序排布字典序一致性断言", () => {
    // 构造 5 个具有不同 totalOrderKey 的源
    const sourceA: GameBuddyAuthoredStableSource = {
      sourceId: "source-a",
      kind: "persona",
      revision: "rev-1",
      canonicalHash: sha256("Content A"),
      content: "Content A",
      budgetTokens: 50,
      totalOrderKey: "0010",
      provenance: "fixture-a",
    };
    const sourceB: GameBuddyAuthoredStableSource = {
      sourceId: "source-b",
      kind: "scenario",
      revision: "rev-2",
      canonicalHash: sha256("Content B"),
      content: "Content B",
      budgetTokens: 60,
      totalOrderKey: "0020",
      provenance: "fixture-b",
    };
    const sourceC: GameBuddyAuthoredStableSource = {
      sourceId: "source-c",
      kind: "dialogue_examples",
      revision: "rev-1",
      canonicalHash: sha256("Content C"),
      content: "Content C",
      budgetTokens: 70,
      totalOrderKey: "0030",
      provenance: "fixture-c",
    };
    const sourceD: GameBuddyAuthoredStableSource = {
      sourceId: "source-d",
      kind: "lorebook_constant",
      revision: "rev-3",
      canonicalHash: sha256("Content D"),
      content: "Content D",
      budgetTokens: 80,
      totalOrderKey: "0040",
      provenance: "fixture-d",
    };
    const sourceE: GameBuddyAuthoredStableSource = {
      sourceId: "source-e",
      kind: "lorebook_constant",
      revision: "rev-4",
      canonicalHash: sha256("Content E"),
      content: "Content E",
      budgetTokens: 90,
      totalOrderKey: "0050",
      provenance: "fixture-e",
    };

    const orderedSources = [sourceA, sourceB, sourceC, sourceD, sourceE];

    // 构造多组乱序排列的 sources 集合
    const permutations: readonly (readonly GameBuddyAuthoredStableSource[])[] = [
      [sourceA, sourceB, sourceC, sourceD, sourceE], // 顺序
      [sourceE, sourceD, sourceC, sourceB, sourceA], // 倒序
      [sourceC, sourceA, sourceE, sourceB, sourceD], // 乱序 1
      [sourceB, sourceE, sourceA, sourceD, sourceC], // 乱序 2
      [sourceD, sourceC, sourceB, sourceE, sourceA], // 乱序 3
    ];

    // 基准渲染：以自然全序排列
    const canonicalOrderKey = (s: GameBuddyAuthoredStableSource) =>
      `${s.totalOrderKey}\0${s.kind}\0${s.sourceId}\0${s.revision}\0${s.canonicalHash}`;

    // 验证测试数据本身的全序递增
    for (let i = 0; i < orderedSources.length - 1; i++) {
      expect(canonicalOrderKey(orderedSources[i]).localeCompare(canonicalOrderKey(orderedSources[i + 1]))).toBeLessThan(0);
    }

    const extractSourcesXml = (block: string): string => {
      const match = block.match(/<gamebuddy-authored-context[^>]*>\n([\s\S]*?)\n<\/gamebuddy-authored-context>/);
      return match ? match[1] : "";
    };

    const baselineCatalog = buildCatalog(standardScope, orderedSources);
    const baselineMaterialized = materializeGameBuddyAuthoredStableCatalog(baselineCatalog, standardScope);
    const baselineSourcesXml = extractSourcesXml(baselineMaterialized.renderedBlock);
    const baselineSourcesSha = sha256(baselineSourcesXml);

    // 断言所有乱序输入渲染出的 XML 中 source-id 顺序与内容严格遵从全序规则
    for (const permutation of permutations) {
      const catalog = buildCatalog(standardScope, permutation);
      const materialized = materializeGameBuddyAuthoredStableCatalog(catalog, standardScope);
      const renderedXml = materialized.renderedBlock;

      // 1. 提取 XML 中 gamebuddy-authored-source 的 source-id 出现序列
      const renderedSourceIds = Array.from(
        renderedXml.matchAll(/<gamebuddy-authored-source [^>]*source-id="([^"]+)"/g),
      ).map((m) => m[1]);

      // 2. 断言出现顺序严格等同于全序排布序列
      expect(renderedSourceIds).toEqual([
        "source-a",
        "source-b",
        "source-c",
        "source-d",
        "source-e",
      ]);

      // 3. 断言物化后的 sources 数组顺序也严格遵循字典序全序规则
      const sortedKeys = materialized.sources.map(canonicalOrderKey);
      const expectedKeys = orderedSources.map(canonicalOrderKey);
      expect(sortedKeys).toEqual(expectedKeys);

      // 4. 断言生成的 <gamebuddy-authored-source> XML 块无论输入排列如何都与基准全序排布完全一致（字节级全等）
      const renderedSourcesXml = extractSourcesXml(renderedXml);
      expect(renderedSourcesXml).toBe(baselineSourcesXml);
      expect(sha256(renderedSourcesXml)).toBe(baselineSourcesSha);
    }
  });

  test("用例 3：转义与多轮 Hash 稳定断言", () => {
    // 包含 & < > 等特殊 XML 控制字符的内容与元数据
    const rawSpecialContent = `Gus & Friends: <Special Dinner> & "Saloon Feast"!\nCondition: player_hp > 50 && energy < 100 -> serve <dish id="apple_pie">.`;
    const specialSourceId = "source<escape>&test>";
    const specialRevision = "rev<1>&2>";
    const specialTotalOrderKey = "0010";

    const specialScope: GameBuddyChatContextScope = {
      continuityId: "cont<alpha>&beta>",
      sessionId: "sess<1>&2>",
      surface: "tavern",
      threadId: "thread<sub&zero>",
      profile: {
        profileId: "prof<hero>&id>",
        revision: 2,
        canonicalHash: "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1",
      },
    };

    const specialSource: GameBuddyAuthoredStableSource = {
      sourceId: specialSourceId,
      kind: "persona",
      revision: specialRevision,
      canonicalHash: sha256(rawSpecialContent),
      content: rawSpecialContent,
      budgetTokens: 100,
      totalOrderKey: specialTotalOrderKey,
      provenance: "fixture-escape",
    };

    const specialCatalog = buildCatalog(specialScope, [specialSource]);
    const materialized = materializeGameBuddyAuthoredStableCatalog(specialCatalog, specialScope);
    const rendered = materialized.renderedBlock;

    // 1. 断言特殊字符被正确转义为 &amp;, &lt;, &gt;
    expect(rendered).toContain("Gus &amp; Friends: &lt;Special Dinner&gt; &amp; \"Saloon Feast\"!");
    expect(rendered).toContain("player_hp &gt; 50 &amp;&amp; energy &lt; 100 -&gt; serve &lt;dish id=\"apple_pie\"&gt;.");
    expect(rendered).toContain('continuity-id="cont&lt;alpha&gt;&amp;beta&gt;"');
    expect(rendered).toContain('session-id="sess&lt;1&gt;&amp;2&gt;"');
    expect(rendered).toContain('thread-id="thread&lt;sub&amp;zero&gt;"');
    expect(rendered).toContain('source-id="source&lt;escape&gt;&amp;test&gt;"');
    expect(rendered).toContain('revision="rev&lt;1&gt;&amp;2&gt;"');

    // 2. 断言除 XML 标签语法定界符外，内容与属性中无任何裸 &、<、> 字符
    // 剥离合法的 XML 标签定界符后检查剩余字符
    const strippedXml = rendered
      .replace(/<\/?gamebuddy-authored-(?:context|source)[^>]*>/g, "");
    expect(strippedXml).not.toMatch(/[<>]/);
    // 确保所有 & 都是已转义实体 &amp;, &lt;, &gt;, &quot;, &apos;
    expect(strippedXml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);

    // 3. 多轮 Hash 稳定断言：模拟连续 10 轮渲染
    const baselineCanonicalHash = specialCatalog.canonicalHash;
    const baselineRenderedSha256 = sha256(rendered);

    for (let round = 1; round <= 10; round++) {
      // 重新克隆并物化目录
      const roundCatalog = buildCatalog(
        { ...specialScope, profile: { ...specialScope.profile } },
        [{ ...specialSource }],
      );

      const roundMaterialized = materializeGameBuddyAuthoredStableCatalog(roundCatalog, specialScope);

      // 断言输入内容不变的情况下，生成的 canonicalHash 严格一致
      expect(roundCatalog.canonicalHash).toBe(baselineCanonicalHash);
      expect(roundMaterialized.snapshotCanonicalHash).toBe(baselineCanonicalHash);

      // 断言物化 XML 及其哈希在多轮中严格不变（保证 Prompt Cache 命中率 100%）
      expect(roundMaterialized.renderedBlock).toBe(rendered);
      expect(sha256(roundMaterialized.renderedBlock)).toBe(baselineRenderedSha256);
      expect(roundMaterialized.budgetTokens).toBe(100);
      expect(roundMaterialized.sources.length).toBe(1);
    }
  });
});
