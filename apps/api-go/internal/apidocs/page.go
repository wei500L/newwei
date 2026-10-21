package apidocs

import (
	"fmt"
	"strconv"
	"strings"
)

// documentURL is the public path of the OpenAPI document. It matches the
// jsonDocumentUrl: "docs/json" option in apps/api/src/main.ts:163-165.
const documentURL = "/docs/json"

// assetBaseURL is the relative prefix the page uses for its own files. NestJS
// passes normalizeRelPath("./" + urlLastSubdirectory + "/"), so the value is
// "./docs/": when a browser opens /docs it resolves "./docs/swagger-ui.css" to
// /docs/swagger-ui.css, exactly like the NestJS page. The page is also served
// at "/docs/" and "/docs/index.html"; those spellings resolve the same relative
// URLs one directory deeper, which is why NestJS additionally mounts the static
// directory at /docs/docs. api-go does not duplicate that mount: the asset
// whitelist in handler.go stays the single source of truth, and those two
// spellings therefore load their assets from /docs/docs/* only if a caller adds
// that mount later (see doc.go for the full difference list).
const assetBaseURL = "./docs/"

// pageTemplate is the Swagger UI page. It references only embedded assets and
// the embedded document, never a CDN. The {{ assetBase }} and {{ documentURL }}
// placeholders are filled in by buildSwaggerUIPage.
const pageTemplate = `<!-- Swagger UI, served by api-go from embedded swagger-ui-dist assets. -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Swagger UI</title>
  <link rel="stylesheet" type="text/css" href="{{ assetBase }}swagger-ui.css">
  <link rel="icon" type="image/png" href="{{ assetBase }}favicon-32x32.png" sizes="32x32">
  <link rel="icon" type="image/png" href="{{ assetBase }}favicon-16x16.png" sizes="16x16">
  <style>
    html {
      box-sizing: border-box;
      overflow: -moz-scrollbars-vertical;
      overflow-y: scroll;
    }
    *, *:before, *:after {
      box-sizing: inherit;
    }
    body {
      margin: 0;
      background: #fafafa;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <!-- The OpenAPI document is loaded from {{ documentURL }} by swagger-ui-init.js. -->
  <script src="{{ assetBase }}swagger-ui-bundle.js" charset="UTF-8"></script>
  <script src="{{ assetBase }}swagger-ui-standalone-preset.js" charset="UTF-8"></script>
  <script src="{{ assetBase }}swagger-ui-init.js" charset="UTF-8"></script>
</body>
</html>
`

// buildSwaggerUIPage renders the page with the relative asset base and the
// document path filled in.
func buildSwaggerUIPage() []byte {
	replacer := strings.NewReplacer(
		"{{ assetBase }}", assetBaseURL,
		"{{ documentURL }}", documentURL,
	)
	return []byte(replacer.Replace(pageTemplate))
}

// initScriptTemplate is the SwaggerUIBundle bootstrap. It is generated rather
// than embedded so the document URL stays one constant, and it must never load
// anything from a CDN.
const initScriptTemplate = `window.onload = function(){ window.ui = SwaggerUIBundle({url: %s, dom_id: "#swagger-ui", deepLinking: true, presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], plugins: [SwaggerUIBundle.plugins.DownloadUrl], layout: "StandaloneLayout"}); };
`

// buildSwaggerInitJS renders /docs/swagger-ui-init.js. The JSON quoting of
// documentURL keeps the script well-formed if the path ever gains a character
// that needs escaping.
func buildSwaggerInitJS() []byte {
	return []byte(fmt.Sprintf(initScriptTemplate, strconv.Quote(documentURL)))
}
