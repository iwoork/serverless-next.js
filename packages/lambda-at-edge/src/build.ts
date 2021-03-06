import execa from "execa";
import { emptyDir, readJSON, pathExists, copy, writeJson } from "fs-extra";
import { join } from "path";
import getAllFiles from "./lib/getAllFilesInDirectory";
import path from "path";
import { getSortedRoutes } from "./lib/sortedRoutes";
import {
  OriginRequestDefaultHandlerManifest,
  OriginRequestApiHandlerManifest
} from "./types";
import isDynamicRoute from "./lib/isDynamicRoute";
import pathToPosix from "./lib/pathToPosix";
import expressifyDynamicRoute from "./lib/expressifyDynamicRoute";
import pathToRegexStr from "./lib/pathToRegexStr";

export const DEFAULT_LAMBDA_CODE_DIR = "default-lambda";
export const API_LAMBDA_CODE_DIR = "api-lambda";

type BuildOptions = {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cmd: string;
};

class Builder {
  nextConfigDir: string;
  outputDir: string;
  buildOptions: BuildOptions = {
    args: [],
    cwd: process.cwd(),
    env: {},
    cmd: "./node_modules/.bin/next"
  };

  constructor(
    nextConfigDir: string,
    outputDir: string,
    buildOptions?: BuildOptions
  ) {
    this.nextConfigDir = nextConfigDir;
    this.outputDir = outputDir;
    if (buildOptions) {
      this.buildOptions = buildOptions;
    }
  }

  async readPublicFiles(): Promise<string[]> {
    const dirExists = await pathExists(join(this.nextConfigDir, "public"));
    if (dirExists) {
      return getAllFiles(join(this.nextConfigDir, "public"))
        .map(e => e.replace(this.nextConfigDir, ""))
        .map(e =>
          e
            .split(path.sep)
            .slice(2)
            .join("/")
        );
    } else {
      return [];
    }
  }

  async readPagesManifest(): Promise<{ [key: string]: string }> {
    const path = join(
      this.nextConfigDir,
      ".next/serverless/pages-manifest.json"
    );
    const hasServerlessPageManifest = await pathExists(path);

    if (!hasServerlessPageManifest) {
      return Promise.reject(
        "pages-manifest not found. Check if `next.config.js` target is set to 'serverless'"
      );
    }

    const pagesManifest = await readJSON(path);
    const pagesManifestWithoutDynamicRoutes = Object.keys(pagesManifest).reduce(
      (acc: { [key: string]: string }, route: string) => {
        if (isDynamicRoute(route)) {
          return acc;
        }

        acc[route] = pagesManifest[route];
        return acc;
      },
      {}
    );

    const dynamicRoutedPages = Object.keys(pagesManifest).filter(
      isDynamicRoute
    );
    const sortedDynamicRoutedPages = getSortedRoutes(dynamicRoutedPages);
    const sortedPagesManifest = pagesManifestWithoutDynamicRoutes;

    sortedDynamicRoutedPages.forEach(route => {
      sortedPagesManifest[route] = pagesManifest[route];
    });

    return sortedPagesManifest;
  }

  buildDefaultLambda(
    buildManifest: OriginRequestDefaultHandlerManifest
  ): Promise<void[]> {
    return Promise.all([
      copy(
        require.resolve("@sls-next/lambda-at-edge/dist/default-handler.js"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "index.js")
      ),
      writeJson(
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "manifest.json"),
        buildManifest
      ),
      copy(
        require.resolve("next-aws-cloudfront"),
        join(
          this.outputDir,
          DEFAULT_LAMBDA_CODE_DIR,
          "node_modules/next-aws-cloudfront/index.js"
        )
      ),
      copy(
        join(this.nextConfigDir, ".next/serverless/pages"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "pages"),
        {
          // skip api pages from default lambda code
          filter: file => {
            const isHTMLPage = path.extname(file) === ".html";
            return pathToPosix(file).indexOf("pages/api") === -1 && !isHTMLPage;
          }
        }
      )
    ]);
  }

  buildApiLambda(
    apiBuildManifest: OriginRequestApiHandlerManifest
  ): Promise<void[]> {
    return Promise.all([
      copy(
        require.resolve("@sls-next/lambda-at-edge/dist/api-handler.js"),
        join(this.outputDir, API_LAMBDA_CODE_DIR, "index.js")
      ),
      copy(
        require.resolve("next-aws-cloudfront"),
        join(
          this.outputDir,
          API_LAMBDA_CODE_DIR,
          "node_modules/next-aws-cloudfront/index.js"
        )
      ),
      copy(
        join(this.nextConfigDir, ".next/serverless/pages/api"),
        join(this.outputDir, API_LAMBDA_CODE_DIR, "pages/api")
      ),
      copy(
        join(this.nextConfigDir, ".next/serverless/pages/_error.js"),
        join(this.outputDir, API_LAMBDA_CODE_DIR, "pages/_error.js")
      ),
      writeJson(
        join(this.outputDir, API_LAMBDA_CODE_DIR, "manifest.json"),
        apiBuildManifest
      )
    ]);
  }

  async prepareBuildManifests(): Promise<{
    defaultBuildManifest: OriginRequestDefaultHandlerManifest;
    apiBuildManifest: OriginRequestApiHandlerManifest;
  }> {
    const pagesManifest = await this.readPagesManifest();

    const defaultBuildManifest: OriginRequestDefaultHandlerManifest = {
      pages: {
        ssr: {
          dynamic: {},
          nonDynamic: {}
        },
        html: {
          dynamic: {},
          nonDynamic: {}
        }
      },
      publicFiles: {}
    };

    const apiBuildManifest: OriginRequestApiHandlerManifest = {
      apis: {
        dynamic: {},
        nonDynamic: {}
      }
    };

    const ssrPages = defaultBuildManifest.pages.ssr;
    const htmlPages = defaultBuildManifest.pages.html;
    const apiPages = apiBuildManifest.apis;

    const isHtmlPage = (path: string): boolean => path.endsWith(".html");
    const isApiPage = (path: string): boolean => path.startsWith("pages/api");

    Object.entries(pagesManifest).forEach(([route, pageFile]) => {
      const dynamicRoute = isDynamicRoute(route);
      const expressRoute = dynamicRoute ? expressifyDynamicRoute(route) : null;

      if (isHtmlPage(pageFile)) {
        if (dynamicRoute) {
          const route = expressRoute as string;
          htmlPages.dynamic[route] = {
            file: pageFile,
            regex: pathToRegexStr(route)
          };
        } else {
          htmlPages.nonDynamic[route] = pageFile;
        }
      } else if (isApiPage(pageFile)) {
        if (dynamicRoute) {
          const route = expressRoute as string;
          apiPages.dynamic[route] = {
            file: pageFile,
            regex: pathToRegexStr(route)
          };
        } else {
          apiPages.nonDynamic[route] = pageFile;
        }
      } else if (dynamicRoute) {
        const route = expressRoute as string;
        ssrPages.dynamic[route] = {
          file: pageFile,
          regex: pathToRegexStr(route)
        };
      } else {
        ssrPages.nonDynamic[route] = pageFile;
      }
    });

    const publicFiles = await this.readPublicFiles();

    publicFiles.forEach(pf => {
      defaultBuildManifest.publicFiles["/" + pf] = pf;
    });

    return {
      defaultBuildManifest,
      apiBuildManifest
    };
  }

  async build(): Promise<void> {
    const { cmd, args, cwd, env } = this.buildOptions;

    await execa(cmd, args, {
      cwd,
      env
    });

    // ensure directories are empty and exist before proceeding
    await emptyDir(join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR));
    await emptyDir(join(this.outputDir, API_LAMBDA_CODE_DIR));

    const {
      defaultBuildManifest,
      apiBuildManifest
    } = await this.prepareBuildManifests();

    await this.buildDefaultLambda(defaultBuildManifest);

    const hasAPIPages =
      Object.keys(apiBuildManifest.apis.nonDynamic).length > 0 ||
      Object.keys(apiBuildManifest.apis.dynamic).length > 0;

    if (hasAPIPages) {
      await this.buildApiLambda(apiBuildManifest);
    }
  }
}

export default Builder;
