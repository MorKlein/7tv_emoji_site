const VALID_FILE_NAME = /^[A-Za-z_]+$/;
const MEDIA_EXTENSIONS = {
  image: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".avif"],
  video: [".mp4", ".webm", ".ogv", ".mov"],
  audio: [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]
};
const DEFAULT_REPO = "emoji_bot";
const DEFAULT_FOLDER = "emoji";

export async function onRequest(context) {
  const { request, env } = context;

  try {
    const config = getConfig(env);

    if (!config.ok) {
      return jsonResponse({ error: config.error }, config.status);
    }

    if (request.method === "GET") {
      const url = new URL(request.url);
      const path = url.searchParams.get("path");

      if (path) {
        return handleMediaRequest(path, config);
      }

      return handleListRequest(request, config);
    }

    if (request.method === "POST") {
      return handleUploadRequest(request, config);
    }

    return jsonResponse({ error: "Method not allowed." }, 405, {
      Allow: "GET, POST"
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unexpected server error." },
      500
    );
  }
}

function getEnvValue(env, name) {
  return typeof env[name] === "string" ? env[name].trim() : "";
}

function getConfig(env) {
  const token = getEnvValue(env, "GIT_TOKEN");
  const owner = getEnvValue(env, "GIT_USER");
  const folder = DEFAULT_FOLDER;

  if (!token) {
    return {
      ok: false,
      status: 500,
      error: "Cloudflare Pages env var GIT_TOKEN is not configured."
    };
  }

  if (!owner) {
    return {
      ok: false,
      status: 500,
      error: "Cloudflare Pages env var GIT_USER is not configured."
    };
  }

  if (!folder) {
    return {
      ok: false,
      status: 500,
      error: "Repository folder is not configured."
    };
  }

  return {
    ok: true,
    token,
    owner,
    repo: DEFAULT_REPO,
    folder
  };
}

async function handleListRequest(request, config) {
  const response = await githubRequest(config, config.folder, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    if (response.status === 404) {
      return jsonResponse({ files: [] });
    }

    return jsonResponse(
      { error: data.message || `GitHub API error (${response.status}).` },
      response.status
    );
  }

  const files = Array.isArray(data)
    ? data
        .filter(item => item.type === "file")
        .map(item => ({
          name: item.name,
          path: item.path,
          mediaType: getMediaType(item.name)
        }))
        .filter(item => item.mediaType)
        .map(item => ({
          ...item,
          url: buildMediaUrl(request, item.path)
        }))
    : [];

  return jsonResponse({ files });
}

async function handleMediaRequest(path, config) {
  const normalizedPath = normalizePath(path);

  if (!normalizedPath || !isPathInsideFolder(normalizedPath, config.folder)) {
    return jsonResponse({ error: "Invalid media path." }, 400);
  }

  const response = await githubRequest(config, normalizedPath, {
    headers: {
      Accept: "application/vnd.github.raw"
    }
  });

  if (!response.ok) {
    let message = `GitHub API error (${response.status}).`;

    try {
      const data = await response.json();
      message = data.message || message;
    } catch {
      // Keep fallback message if GitHub does not return JSON.
    }

    return jsonResponse({ error: message }, response.status);
  }

  const headers = new Headers();
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Content-Type", response.headers.get("Content-Type") || getMimeType(normalizedPath));

  return new Response(response.body, {
    status: 200,
    headers
  });
}

async function handleUploadRequest(request, config) {
  const formData = await request.formData();
  const name = typeof formData.get("name") === "string" ? formData.get("name").trim() : "";
  const file = formData.get("file");

  if (!name || !VALID_FILE_NAME.test(name)) {
    return jsonResponse(
      { error: "File name must contain only English letters and underscores." },
      400
    );
  }

  if (!file || typeof file.arrayBuffer !== "function" || typeof file.name !== "string") {
    return jsonResponse({ error: "No file uploaded." }, 400);
  }

  const mediaType = getMediaType(file.name);

  if (!mediaType) {
    return jsonResponse({ error: "Only image, video, and audio files are allowed." }, 400);
  }

  const extension = getExtension(file.name);
  const repoPath = joinPath(config.folder, `${name}${extension}`);
  const content = arrayBufferToBase64(await file.arrayBuffer());

  try {
    const existingSha = await getExistingSha(config, repoPath);

    if (existingSha) {
      return jsonResponse({ error: "A file with this name already exists." }, 409);
    }

    const payload = {
      message: `Add ${repoPath}`,
      content
    };

    const response = await githubRequest(config, repoPath, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return jsonResponse(
        { error: data.message || `Upload failed with status ${response.status}.` },
        response.status
      );
    }

    return jsonResponse({
      ok: true,
      file: {
        name: `${name}${extension}`,
        path: repoPath,
        mediaType,
        url: buildMediaUrl(request, repoPath)
      }
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Upload failed." },
      500
    );
  }
}

async function getExistingSha(config, path) {
  const response = await githubRequest(config, path, {
    headers: {
      Accept: "application/vnd.github+json"
    }
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Unable to check existing file: ${response.status}`);
  }

  const data = await response.json();
  return typeof data.sha === "string" ? data.sha : null;
}

function githubRequest(config, path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${config.token}`);
  headers.set("User-Agent", "cloudflare-pages-media-uploader");
  headers.set("X-GitHub-Api-Version", "2022-11-28");

  return fetch(
    `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${encodeGitHubPath(path)}`,
    {
      ...init,
      headers
    }
  );
}

function buildMediaUrl(request, path) {
  const url = new URL(request.url);
  url.search = "";
  url.searchParams.set("path", path);
  return url.pathname + url.search;
}

function getMediaType(name) {
  const lowerName = name.toLowerCase();

  if (MEDIA_EXTENSIONS.image.some(ext => lowerName.endsWith(ext))) {
    return "image";
  }

  if (MEDIA_EXTENSIONS.video.some(ext => lowerName.endsWith(ext))) {
    return "video";
  }

  if (MEDIA_EXTENSIONS.audio.some(ext => lowerName.endsWith(ext))) {
    return "audio";
  }

  return null;
}

function getMimeType(path) {
  const lowerPath = path.toLowerCase();

  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (lowerPath.endsWith(".png")) {
    return "image/png";
  }

  if (lowerPath.endsWith(".gif")) {
    return "image/gif";
  }

  if (lowerPath.endsWith(".webp")) {
    return "image/webp";
  }

  if (lowerPath.endsWith(".svg")) {
    return "image/svg+xml";
  }

  if (lowerPath.endsWith(".bmp")) {
    return "image/bmp";
  }

  if (lowerPath.endsWith(".avif")) {
    return "image/avif";
  }

  if (lowerPath.endsWith(".mp4")) {
    return "video/mp4";
  }

  if (lowerPath.endsWith(".webm")) {
    return "video/webm";
  }

  if (lowerPath.endsWith(".ogv")) {
    return "video/ogg";
  }

  if (lowerPath.endsWith(".mov")) {
    return "video/quicktime";
  }

  if (lowerPath.endsWith(".mp3")) {
    return "audio/mpeg";
  }

  if (lowerPath.endsWith(".wav")) {
    return "audio/wav";
  }

  if (lowerPath.endsWith(".ogg")) {
    return "audio/ogg";
  }

  if (lowerPath.endsWith(".m4a")) {
    return "audio/mp4";
  }

  if (lowerPath.endsWith(".aac")) {
    return "audio/aac";
  }

  if (lowerPath.endsWith(".flac")) {
    return "audio/flac";
  }

  return "application/octet-stream";
}

function getExtension(name) {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

function joinPath(...parts) {
  return parts
    .map(part => normalizePath(part))
    .filter(Boolean)
    .join("/");
}

function normalizePath(path) {
  const trimmed = typeof path === "string" ? path.trim() : "";

  if (!trimmed) {
    return "";
  }

  const parts = trimmed.split("/").filter(Boolean);

  if (parts.some(part => part === "." || part === "..")) {
    return "";
  }

  return parts.join("/");
}

function isPathInsideFolder(path, folder) {
  return path === folder || path.startsWith(`${folder}/`);
}

function encodeGitHubPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=UTF-8");

  return new Response(JSON.stringify(payload), {
    status,
    headers
  });
}


