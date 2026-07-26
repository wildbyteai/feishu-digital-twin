function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function decodeXmlText(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function plainText(value) {
  if (typeof value !== "string") return "";
  return decodeXmlText(value.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
}

function expectedTitle(targetDate, principalName) {
  if (typeof principalName !== "string" || principalName.trim().length === 0) {
    throw new TypeError("principalName must be a non-empty string");
  }
  return `${targetDate} ${principalName.trim()}每日工作记忆`;
}

function bodyText(content) {
  if (typeof content !== "string") return "";
  return plainText(content.replace(/<title\b[^>]*>[\s\S]*?<\/title>/iu, ""));
}

function hasExactLeadingTitle(content, targetDate, principalName) {
  if (typeof content !== "string") return false;
  const leadingTitle = content.trimStart().match(/^<title>([\s\S]*?)<\/title>/u);
  const openingTitles = content.match(/<title\b[^>]*>/giu) ?? [];
  const closingTitles = content.match(/<\/title\s*>/giu) ?? [];
  return openingTitles.length === 1 &&
    closingTitles.length === 1 &&
    leadingTitle?.[1] === expectedTitle(targetDate, principalName);
}

function exactSearchFeedback(feedback, targetDate, folderToken, principalName) {
  const title = expectedTitle(targetDate, principalName);
  return [...feedback].reverse().find((item) => {
    const argv = item?.command?.argv ?? [];
    return item?.result?.status === "complete" &&
      argv[0] === "drive" &&
      argv[1] === "+search" &&
      flagValue(argv, "--query") === title &&
      flagValue(argv, "--folder-tokens") === folderToken &&
      flagValue(argv, "--doc-types") === "docx" &&
      argv.includes("--only-title");
  });
}

function exactDocuments(feedback, targetDate, folderToken, principalName) {
  const search = exactSearchFeedback(feedback, targetDate, folderToken, principalName);
  if (!search) {
    throw new Error("daily memory write requires a completed exact-title search");
  }
  if (search.result.data?.has_more !== false) {
    throw new Error("daily memory exact-title search is incomplete; refusing to create or overwrite");
  }
  const title = expectedTitle(targetDate, principalName);
  return (search.result.data?.results ?? [])
    .filter((result) => plainText(result?.title_highlighted) === title)
    .filter((result) => typeof result?.result_meta?.token === "string")
    .sort((left, right) => Number(right.result_meta.update_time ?? 0) - Number(left.result_meta.update_time ?? 0));
}

function assertFullBody(command, targetDate, principalName) {
  const content = flagValue(command.argv, "--content");
  if (!hasExactLeadingTitle(content, targetDate, principalName)) {
    throw new Error("daily memory content must keep the exact date title");
  }
  if (bodyText(content).length === 0) {
    throw new Error("daily memory content must include a non-empty body");
  }
}

export function assertDailyMemoryCommand(command, {
  feedback,
  targetDate,
  folderToken,
  principalName
}) {
  const argv = command?.argv ?? [];
  if (argv[0] !== "docs" || !new Set(["+create", "+update"]).has(argv[1])) return;

  const documents = exactDocuments(feedback, targetDate, folderToken, principalName);
  assertFullBody(command, targetDate, principalName);

  if (argv[1] === "+create") {
    if (documents.length > 0) {
      throw new Error("same-date daily memory already exists; update the original document instead");
    }
    if (flagValue(argv, "--parent-token") !== folderToken) {
      throw new Error("daily memory must be created in the configured folder");
    }
    return;
  }

  if (flagValue(argv, "--command") !== "overwrite") {
    throw new Error("same-date daily memory must be updated with overwrite");
  }
  if (documents.length === 0) {
    throw new Error("daily memory update requires an existing same-date document");
  }
  if (flagValue(argv, "--doc") !== documents[0].result_meta.token) {
    throw new Error("daily memory must update the newest existing same-date document");
  }
}

function createdDocumentToken(data) {
  return data?.document?.document_id ?? data?.document?.token ?? data?.document_id ?? data?.token;
}

function completedWriteIndex(feedback) {
  return feedback.findLastIndex((item) => {
    const argv = item?.command?.argv ?? [];
    return item?.result?.status === "complete" &&
      argv[0] === "docs" &&
      new Set(["+create", "+update"]).has(argv[1]);
  });
}

function completedWriteTarget(feedback, writeIndex) {
  const write = feedback[writeIndex];
  const argv = write?.command?.argv ?? [];
  return argv[1] === "+update"
    ? flagValue(argv, "--doc")
    : createdDocumentToken(write?.result?.data);
}

function isTargetFetch(item, targetToken) {
  const argv = item?.command?.argv ?? [];
  return argv[0] === "docs" &&
    argv[1] === "+fetch" &&
    flagValue(argv, "--doc") === targetToken;
}

function attemptedFetch(feedback, writeIndex, targetToken) {
  return feedback.slice(writeIndex + 1).find(
    (item) => isTargetFetch(item, targetToken)
  );
}

function verifiedFetch(feedback, writeIndex, targetToken) {
  return feedback.slice(writeIndex + 1).findLast(
    (item) => item?.result?.status === "complete" && isTargetFetch(item, targetToken)
  );
}

export function dailyMemoryVerificationStatus({
  feedback,
  targetDate,
  folderToken,
  principalName
}) {
  const writeIndex = completedWriteIndex(feedback);
  if (writeIndex < 0) return "missing-write";
  const documents = exactDocuments(feedback, targetDate, folderToken, principalName);
  const targetToken = completedWriteTarget(feedback, writeIndex);
  if (typeof targetToken !== "string" || targetToken.length === 0) return "missing-token";
  if (documents.length > 0 && targetToken !== documents[0].result_meta.token) {
    return "wrong-document";
  }
  const verification = verifiedFetch(feedback, writeIndex, targetToken);
  if (!verification) return "missing-fetch";
  const content = verification.result.data?.document?.content;
  if (!hasExactLeadingTitle(content, targetDate, principalName)) return "unexpected-title";
  if (bodyText(content).length === 0) return "empty-body";
  return "complete";
}

export function dailyMemoryProgress({ feedback, targetDate, folderToken, principalName }) {
  const search = exactSearchFeedback(feedback, targetDate, folderToken, principalName);
  const searchComplete = search !== undefined && search.result.data?.has_more === false;
  const writeIndex = completedWriteIndex(feedback);
  const write = writeIndex >= 0 ? feedback[writeIndex] : null;
  const targetToken = writeIndex >= 0 ? completedWriteTarget(feedback, writeIndex) : null;
  const verificationComplete = dailyMemoryVerificationStatus({
    feedback,
    targetDate,
    folderToken,
    principalName
  }) === "complete";

  const requiredNextStep = !searchComplete
    ? "执行指定文件夹内的同日精确标题搜索；没有该结果时禁止写入或新建。"
    : writeIndex < 0
    ? "根据精确标题搜索结果立即更新原文档或创建唯一日报，正文不能为空。"
    : !verificationComplete
    ? "对刚写入的同一文档 token 执行 docs +fetch，并确认正文非空。"
    : "日报闭环已完成，不再生成飞书命令。";

  return {
    search_complete: searchComplete,
    write_complete: writeIndex >= 0,
    verification_complete: verificationComplete,
    complete: searchComplete && writeIndex >= 0 && verificationComplete,
    required_next_step: requiredNextStep
  };
}

export function requiredDailyMemoryVerificationCommand({
  feedback,
  targetDate,
  folderToken,
  principalName
}) {
  const documents = exactDocuments(feedback, targetDate, folderToken, principalName);
  const writeIndex = completedWriteIndex(feedback);
  if (writeIndex < 0) return null;
  const targetToken = completedWriteTarget(feedback, writeIndex);
  if (typeof targetToken !== "string" || targetToken.length === 0) {
    throw new Error("daily memory write did not return a document token");
  }
  if (documents.length > 0 && targetToken !== documents[0].result_meta.token) {
    throw new Error("daily memory verification must use the original same-date document");
  }
  if (attemptedFetch(feedback, writeIndex, targetToken)) return null;
  return {
    argv: ["docs", "+fetch", "--doc", targetToken],
    reason: "验证刚写入的日报正文",
    confirmation: "auto"
  };
}

export function assertDailyMemoryCompletion({
  feedback,
  targetDate,
  folderToken,
  principalName
}) {
  const documents = exactDocuments(feedback, targetDate, folderToken, principalName);
  const writeIndex = completedWriteIndex(feedback);
  if (writeIndex < 0) {
    throw new Error("daily memory run completed without writing the document");
  }

  const targetToken = completedWriteTarget(feedback, writeIndex);
  if (typeof targetToken !== "string" || targetToken.length === 0) {
    throw new Error("daily memory write did not return a document token");
  }
  if (documents.length > 0 && targetToken !== documents[0].result_meta.token) {
    throw new Error("daily memory verification must use the original same-date document");
  }

  const verification = verifiedFetch(feedback, writeIndex, targetToken);
  if (!verification) {
    throw new Error("daily memory write must be followed by docs +fetch verification");
  }

  const content = verification.result.data?.document?.content;
  if (!hasExactLeadingTitle(content, targetDate, principalName)) {
    throw new Error("daily memory verification found an unexpected title");
  }
  if (bodyText(content).length === 0) {
    throw new Error("daily memory verification found an empty body");
  }
}
