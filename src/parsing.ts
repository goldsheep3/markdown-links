import * as vscode from "vscode";
import * as path from "path";
import * as unified from "unified";
import * as markdown from "remark-parse";
import * as wikiLinkPlugin from "remark-wiki-link";
import * as frontmatter from "remark-frontmatter";
import { MarkdownNode, Graph } from "./types";
import { TextDecoder } from "util";
import {
  findTitle,
  findLinks,
  id,
  FILE_ID_REGEXP,
  getFileTypesSetting,
  getConfiguration,
  getTitleMaxLength,
} from "./utils";
import { basename } from "path";

let idToPath: Record<string, string> = {};

export const idResolver = (id: string) => {
  const filePath = idToPath[id];
  if (filePath === undefined) {
    return [id];
  } else {
    return [filePath];
  }
};

const parser = unified()
  .use(markdown)
  .use(wikiLinkPlugin, { pageResolver: idResolver })
  .use(frontmatter);

export const parseFile = async (graph: Graph, filePath: string) => {
  filePath = path.normalize(filePath);
  const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  const content = new TextDecoder("utf-8").decode(buffer);
  const ast: MarkdownNode = parser.parse(content);

  let title: string | null = findTitle(ast);

  const index = graph.nodes.findIndex((node) => node.path === filePath);

  if (!title) {
    if (index !== -1) {
      graph.nodes.splice(index, 1);
    }

    return;
  }

  if (index !== -1) {
    graph.nodes[index].label = title;
  } else {
    graph.nodes.push({ id: id(filePath), path: filePath, label: title });
  }

  // Remove edges based on an old version of this file.
  graph.edges = graph.edges.filter((edge) => edge.source !== id(filePath));

  // Returns a list of decoded links (by default markdown only supports encoded URI)
  const links = findLinks(ast).map(uri => decodeURI(uri));
  const parentDirectory = filePath.split(path.sep).slice(0, -1).join(path.sep);

  for (const link of links) {
    let target: string;
    let root = vscode.workspace.rootPath || "";
    if (link.startsWith("/")) {
      // If starts with '/', treat as path relative to workspace root
      target = path.normalize(path.join(root, link));
      // On Windows, force a leading backslash for consistency
      if (process.platform === "win32" && !target.startsWith("\\")) {
        target = "\\" + target;
      }
    } else if (!path.isAbsolute(link)) {
      // Relative path, based on current file's directory
      target = path.normalize(`${parentDirectory}/${link}`);
    } else {
      // Absolute path (disk path)
      target = path.normalize(link);
    }

    graph.edges.push({ source: id(filePath), target: id(target) });
  }
};

export const findFileId = async (filePath: string): Promise<string | null> => {
  const buffer = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  const content = new TextDecoder("utf-8").decode(buffer);

  const match = content.match(FILE_ID_REGEXP);
  return match ? match[1] : null;
};

export const learnFileId = async (_graph: Graph, filePath: string) => {
  const id = await findFileId(filePath);
  if (id !== null) {
    idToPath[id] = filePath;
  }

  const fileName = basename(filePath);
  idToPath[fileName] = filePath;

  const fileNameWithoutExt = fileName.split(".").slice(0, -1).join(".");
  idToPath[fileNameWithoutExt] = filePath;
};

export const parseDirectory = async (
  graph: Graph,
  fileCallback: (graph: Graph, path: string) => Promise<void>
) => {
  // `findFiles` is used here since it respects files excluded by either the
  // global or workspace level files.exclude config option.
  const files = await vscode.workspace.findFiles(
    `**/*{${(getFileTypesSetting() as string[]).map((f) => `.${f}`).join(",")}}`
  );

  const promises: Promise<void>[] = [];

  for (const file of files) {
    const hiddenFile = path.basename(file.path).startsWith(".");
    if (!hiddenFile) {
      promises.push(fileCallback(graph, file.path));
    }
  }

  await Promise.all(promises);
};
