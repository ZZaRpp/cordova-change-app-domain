const fs = require('fs');
const path = require('path');

const PLUGIN_ID = 'cordova-plugin-outsystems-custom-domain';
const BUILTIN_DOMAIN_PATTERNS = [
  /^[a-z0-9-]+\.outsystems\.app$/i,
  /^[a-z0-9-]+\.outsystemscloud\.com$/i
];

const WWW_EXTENSIONS = ['.html', '.htm', '.js', '.json', '.xml'];
const SKIP_DIRS = new Set(['node_modules', 'platforms', 'plugins', '.git']);

function fail(message) {
  console.error('OUTSYSTEMS_PLUGIN_ERROR: ' + message);
  throw new Error(message);
}

function readConfigXml(projectRoot) {
  const configPath = path.join(projectRoot, 'config.xml');
  if (!fs.existsSync(configPath)) {
    fail(`${PLUGIN_ID}: could not find config.xml at ${configPath}`);
  }
  return { configPath, content: fs.readFileSync(configPath, 'utf8') };
}

function getPreference(configXmlContent, name) {
  const re = new RegExp(`<preference\\s+name="${name}"\\s+value="([^"]*)"\\s*/?>`, 'i');
  const match = configXmlContent.match(re);
  return match ? match[1] : undefined;
}

function normalizeDomain(value) {
  if (!value) return value;
  return value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

function toBool(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function detectBuiltinDomain(configXmlContent) {
  const contentMatch = configXmlContent.match(/<content\s+[^>]*src="(https?:\/\/[^"]+)"/i);
  if (!contentMatch) return undefined;
  let host;
  try {
    host = new URL(contentMatch[1]).host;
  } catch (e) {
    return undefined;
  }
  const isKnownBuiltin = BUILTIN_DOMAIN_PATTERNS.some((re) => re.test(host));
  return isKnownBuiltin ? host : undefined;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceContentSrc(configXmlContent, builtinDomain, customDomain) {
  const domainRe = new RegExp(escapeRegExp(builtinDomain));
  let replacedCount = 0;
  const updated = configXmlContent.replace(
    /(<content\s+[^>]*src=")(https?:\/\/[^"]+)(")/i,
    (full, prefix, url, suffix) => {
      if (!domainRe.test(url)) return full;
      replacedCount += 1;
      return prefix + url.replace(new RegExp(escapeRegExp(builtinDomain), 'g'), customDomain) + suffix;
    }
  );
  return { updated, replacedCount };
}

function ensureAccessAndNavigation(configXmlContent, domain) {
  let updated = configXmlContent;
  const origin = `https://${domain}`;
  const navHref = `https://${domain}/*`;

  const hasAccess = new RegExp(`<access\\s+origin="${escapeRegExp(origin)}"`, 'i').test(updated);
  const hasNav = new RegExp(`<allow-navigation\\s+href="${escapeRegExp(navHref)}"`, 'i').test(updated);

  const insertions = [];
  if (!hasAccess) insertions.push(`    <access origin="${origin}" />`);
  if (!hasNav) insertions.push(`    <allow-navigation href="${navHref}" />`);

  if (insertions.length === 0) return updated;

  const anchorRe = /(<content\s+[^>]*\/>\s*)/i;
  if (anchorRe.test(updated)) {
    updated = updated.replace(anchorRe, `$1\n${insertions.join('\n')}\n`);
  } else {
    updated = updated.replace(/<\/widget>/i, `${insertions.join('\n')}\n</widget>`);
  }
  return updated;
}

function removeAccessAndNavigationForDomain(configXmlContent, domain) {
  const origin = `https://${domain}`;
  const navHref = `https://${domain}/*`;
  let updated = configXmlContent;
  updated = updated.replace(new RegExp(`[ \\t]*<access\\s+origin="${escapeRegExp(origin)}"\\s*/?>\\n?`, 'gi'), '');
  updated = updated.replace(new RegExp(`[ \\t]*<allow-navigation\\s+href="${escapeRegExp(navHref)}"\\s*/?>\\n?`, 'gi'), '');
  return updated;
}

function walkWwwFiles(dir, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkWwwFiles(fullPath, results);
    } else if (WWW_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
}

function patchWwwFiles(projectRoot, builtinDomain, customDomain) {
  const wwwDir = path.join(projectRoot, 'www');
  if (!fs.existsSync(wwwDir)) return 0;

  const files = [];
  walkWwwFiles(wwwDir, files);

  const domainRe = new RegExp(escapeRegExp(builtinDomain));
  let patchedFiles = 0;

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue; // skip unreadable / binary files
    }
    if (!domainRe.test(content)) continue;
    const updated = content.replace(new RegExp(escapeRegExp(builtinDomain), 'g'), customDomain);
    fs.writeFileSync(file, updated, 'utf8');
    patchedFiles += 1;
    console.log(`[${PLUGIN_ID}] patched ${path.relative(projectRoot, file)}`);
  }
  return patchedFiles;
}

module.exports = function (context) {
  const projectRoot = (context && context.opts && context.opts.projectRoot) || process.cwd();

  const { configPath, content: originalConfigXml } = readConfigXml(projectRoot);

  const customDomainRaw = getPreference(originalConfigXml, 'CUSTOM_DOMAIN') || process.env.CUSTOM_DOMAIN;
  const customDomain = normalizeDomain(customDomainRaw);

  if (!customDomain) {
    fail(
      `${PLUGIN_ID}: the CUSTOM_DOMAIN plugin variable is required, e.g. ` +
      `"cordova plugin add ${PLUGIN_ID} --variable CUSTOM_DOMAIN=myapp.example.com".`
    );
  }

  const builtinDomainRaw = getPreference(originalConfigXml, 'BUILTIN_DOMAIN') || process.env.BUILTIN_DOMAIN;
  const builtinDomain = normalizeDomain(builtinDomainRaw) || detectBuiltinDomain(originalConfigXml);

  if (!builtinDomain) {
    fail(
      `${PLUGIN_ID}: could not auto-detect the built-in OutSystems domain from <content src> ` +
      `in config.xml. Set it explicitly with the BUILTIN_DOMAIN plugin variable, e.g. ` +
      `"--variable BUILTIN_DOMAIN=yourorg.outsystems.app".`
    );
  }

  if (builtinDomain === customDomain) {
    console.log(`[${PLUGIN_ID}] BUILTIN_DOMAIN and CUSTOM_DOMAIN are identical (${customDomain}) - nothing to do.`);
    return;
  }

  const keepBuiltinAccess = toBool(
    getPreference(originalConfigXml, 'KEEP_BUILTIN_DOMAIN_ACCESS') || process.env.KEEP_BUILTIN_DOMAIN_ACCESS,
    true
  );
  const patchWww = toBool(
    getPreference(originalConfigXml, 'PATCH_WWW_FILES') || process.env.PATCH_WWW_FILES,
    true
  );

  console.log(`[${PLUGIN_ID}] rewriting built-in domain "${builtinDomain}" -> custom domain "${customDomain}"`);

  let configXml = originalConfigXml;

  const { updated: withContentSrc, replacedCount } = replaceContentSrc(configXml, builtinDomain, customDomain);
  configXml = withContentSrc;
  if (replacedCount === 0) {
    console.log(`[${PLUGIN_ID}] warning: <content src> did not reference ${builtinDomain}; only whitelist entries were updated.`);
  }

  configXml = ensureAccessAndNavigation(configXml, customDomain);

  if (!keepBuiltinAccess) {
    configXml = removeAccessAndNavigationForDomain(configXml, builtinDomain);
  }

  if (configXml !== originalConfigXml) {
    fs.writeFileSync(configPath, configXml, 'utf8');
    console.log(`[${PLUGIN_ID}] updated ${path.relative(projectRoot, configPath)}`);
  }

  if (patchWww) {
    const patchedCount = patchWwwFiles(projectRoot, builtinDomain, customDomain);
    console.log(`[${PLUGIN_ID}] patched ${patchedCount} file(s) under www/`);
  }

  console.log(`[${PLUGIN_ID}] done.`);
};
