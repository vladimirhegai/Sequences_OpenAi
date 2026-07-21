import { parseHTMLContent } from "@hyperframes/core/compiler/html-document";

export interface HtmlEvidence {
  path: string;
  document: Document;
  elements: Element[];
  styleText: string;
  scriptText: string;
}

export function parseHtmlEvidence(path: string, source: string): HtmlEvidence {
  let document: Document;
  try {
    document = parseHTMLContent(source);
  } catch (error) {
    throw new Error(`${path} is not parseable HTML: ${errorMessage(error)}`);
  }

  const elements = collectElements(document);
  const styleText = elements
    .filter((element) => element.tagName.toLowerCase() === "style")
    .map((element) => element.textContent ?? "")
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const scriptText = elements
    .filter((element) => element.tagName.toLowerCase() === "script")
    .map((element) => element.textContent ?? "")
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "");

  return { path, document, elements, styleText, scriptText };
}

export function elementsWithAttribute(
  files: readonly HtmlEvidence[],
  attribute: string,
  value: string,
): Array<{ file: HtmlEvidence; element: Element }> {
  return files.flatMap((file) =>
    file.elements
      .filter((element) => element.getAttribute(attribute) === value)
      .map((element) => ({ file, element })),
  );
}

function collectElements(root: Document | DocumentFragment): Element[] {
  const direct = Array.from(root.querySelectorAll("*"));
  const nested = direct.flatMap((element) => {
    if (element.tagName.toLowerCase() !== "template") return [];
    const content = (element as HTMLTemplateElement).content;
    return content ? collectElements(content) : [];
  });
  return [...direct, ...nested];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
