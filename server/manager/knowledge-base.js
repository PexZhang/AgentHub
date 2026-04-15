import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_KNOWLEDGE_DIR = join(__dirname, "..", "..", "knowledge", "manager");

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeSpace(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function stripMarkdown(source) {
  return normalizeSpace(
    String(source || "")
      .replace(/^---[\s\S]*?---\s*/u, "")
      .replace(/`{1,3}[^`]*`{1,3}/g, " ")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/^#+\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/[*_~>-]/g, " ")
  );
}

function parseFrontmatter(raw) {
  const match = String(raw || "").match(/^---\n([\s\S]*?)\n---\n?/u);
  if (!match) {
    return {
      metadata: {},
      body: String(raw || ""),
    };
  }

  const metadata = {};
  for (const line of match[1].split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizeText(line.slice(0, separatorIndex)).toLowerCase();
    const rawValue = normalizeText(line.slice(separatorIndex + 1));
    if (!key || !rawValue) {
      continue;
    }

    metadata[key] = rawValue;
  }

  return {
    metadata,
    body: String(raw || "").slice(match[0].length),
  };
}

function parseKeywords(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(/[;,，、]/)
        .map((item) => normalizeSpace(item).toLowerCase())
        .filter(Boolean)
    )
  );
}

function buildExcerpt(body, maxLength = 220) {
  const plain = stripMarkdown(body);
  if (plain.length <= maxLength) {
    return plain;
  }

  return `${plain.slice(0, maxLength).trim()}...`;
}

function parseArticle(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const { metadata, body } = parseFrontmatter(raw);
  const plain = stripMarkdown(body);
  const titleFromBody =
    String(body || "").match(/^#\s+(.+)$/m)?.[1] ||
    normalizeText(metadata.title) ||
    filePath.split("/").pop()?.replace(/\.md$/i, "") ||
    "未命名知识";
  const title = normalizeSpace(metadata.title || titleFromBody);
  const summary =
    normalizeSpace(metadata.summary) ||
    buildExcerpt(plain, 120) ||
    "暂无摘要。";
  const keywords = parseKeywords(metadata.keywords);

  return {
    id:
      normalizeSpace(metadata.id).toLowerCase() ||
      filePath.split("/").pop()?.replace(/\.md$/i, "").toLowerCase() ||
      title.toLowerCase(),
    title,
    summary,
    keywords,
    body: normalizeSpace(plain),
    excerpt: buildExcerpt(plain),
    path: filePath,
  };
}

function collectArticles(knowledgeDir = DEFAULT_KNOWLEDGE_DIR) {
  if (!existsSync(knowledgeDir)) {
    return [];
  }

  return readdirSync(knowledgeDir)
    .filter((entry) => entry.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"))
    .map((entry) => parseArticle(join(knowledgeDir, entry)));
}

function scoreArticle(article, query) {
  const normalizedQuery = normalizeSpace(query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  let score = 0;
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const compactTitle = article.title.toLowerCase().replace(/\s+/g, "");
  const compactSummary = article.summary.toLowerCase().replace(/\s+/g, "");
  const compactBody = article.body.toLowerCase().replace(/\s+/g, "");

  if (compactTitle.includes(compactQuery) || compactQuery.includes(compactTitle)) {
    score += 10;
  }

  if (compactSummary.includes(compactQuery)) {
    score += 6;
  }

  if (compactBody.includes(compactQuery)) {
    score += 3;
  }

  for (const keyword of article.keywords) {
    const compactKeyword = keyword.replace(/\s+/g, "");
    if (!compactKeyword) {
      continue;
    }

    if (compactQuery.includes(compactKeyword) || compactKeyword.includes(compactQuery)) {
      score += 5;
      continue;
    }

    if (compactQuery.includes(keyword) || keyword.includes(normalizedQuery)) {
      score += 4;
    }
  }

  const queryTerms = normalizedQuery
    .split(/[\s,，、;；/]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  for (const term of queryTerms) {
    const compactTerm = term.replace(/\s+/g, "");
    if (compactTitle.includes(compactTerm)) {
      score += 2;
    } else if (compactSummary.includes(compactTerm)) {
      score += 1.5;
    } else if (compactBody.includes(compactTerm)) {
      score += 0.5;
    }
  }

  return score;
}

export function loadManagerKnowledgeBase(knowledgeDir = DEFAULT_KNOWLEDGE_DIR) {
  const articles = collectArticles(knowledgeDir);
  return {
    knowledgeDir,
    articles,
  };
}

export function buildManagerKnowledgePrompt(knowledgeBase) {
  const articles = Array.isArray(knowledgeBase?.articles) ? knowledgeBase.articles : [];
  if (articles.length === 0) {
    return "当前没有额外的经理知识条目。";
  }

  return [
    "你还掌握这份 AgentHub 内置知识目录；当用户问平台规则、接入方式、职责边界或扩展方法时，要优先利用这些知识：",
    ...articles.map(
      (article, index) =>
        `${index + 1}. ${article.title}：${article.summary}${
          article.keywords.length ? `（关键词：${article.keywords.join(" / ")}）` : ""
        }`
    ),
  ].join("\n");
}

export function searchManagerKnowledge(knowledgeBase, query, limit = 3) {
  const articles = Array.isArray(knowledgeBase?.articles) ? knowledgeBase.articles : [];

  return articles
    .map((article) => ({
      article,
      score: scoreArticle(article, query),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit))
    .map((item) => ({
      ...item.article,
      score: item.score,
    }));
}

export function formatKnowledgeReply(query, results) {
  if (!Array.isArray(results) || results.length === 0) {
    return "这块我手头还没有成体系的经理知识条目。你可以先告诉我你要解决的是接入、任务编排还是平台职责，我再按现有状态帮你判断。";
  }

  const header = `我先按“${normalizeSpace(query)}”给你汇总平台知识：`;
  const sections = results.slice(0, 3).map((article) => {
    const lines = [`${article.title}：${article.summary}`];
    if (article.excerpt && article.excerpt !== article.summary) {
      lines.push(`要点：${article.excerpt}`);
    }
    return lines.join("\n");
  });

  return [header, ...sections].join("\n\n");
}
