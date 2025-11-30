"use client";

import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import {
  Button,
  Card,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import type { FormInstance } from "antd/es/form";
import dayjs from "dayjs";
import type { CreateCrawlTaskFormValues } from "../types";

interface CreateCrawlTaskDrawerProps {
  form: FormInstance<CreateCrawlTaskFormValues>;
  open: boolean;
  loading: boolean;
  onClose: () => void;
  onSubmit: (values: CreateCrawlTaskFormValues) => void | Promise<void>;
}

export function CreateCrawlTaskDrawer({
  form,
  open,
  loading,
  onClose,
  onSubmit,
}: CreateCrawlTaskDrawerProps) {
  const scanFullPage = Form.useWatch("scanFullPage", form);
  const proxyUrlValue = Form.useWatch("proxyUrl", form);
  const proxyConfigValue = Form.useWatch("proxyConfig", form);
  const markdownFilterType = Form.useWatch(["markdownFilter", "type"], form);
  const scoreLinksValue = Form.useWatch("scoreLinks", form);
  const userAgentModeValue = Form.useWatch("userAgentMode", form);
  const useManagedBrowserValue = Form.useWatch("useManagedBrowser", form);

  const proxyUrlActive = Boolean(proxyUrlValue?.trim().length);
  const proxyObjectActive = Boolean(proxyConfigValue?.server?.trim().length);
  const linkPreviewDisabled = !scoreLinksValue;

  return (
    <Drawer
      title="New Crawl Task"
      placement="right"
      width={420}
      open={open}
      onClose={onClose}
      destroyOnClose
    >
      <Form layout="vertical" form={form} onFinish={onSubmit}>
        <CrawlSettingsForm
          scanFullPage={scanFullPage}
          markdownFilterType={markdownFilterType}
          linkPreviewDisabled={linkPreviewDisabled}
        />
        <BrowserConfigForm
          userAgentModeValue={userAgentModeValue}
          useManagedBrowserValue={useManagedBrowserValue}
          proxyUrlActive={proxyUrlActive}
          proxyObjectActive={proxyObjectActive}
        />
        <Space style={{ width: "100%", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" htmlType="submit" loading={loading}>
            Queue Task
          </Button>
        </Space>
      </Form>
    </Drawer>
  );
}

interface CrawlSettingsFormProps {
  scanFullPage?: boolean;
  markdownFilterType?: string;
  linkPreviewDisabled: boolean;
}

function CrawlSettingsForm({
  scanFullPage,
  markdownFilterType,
  linkPreviewDisabled,
}: CrawlSettingsFormProps) {
  return (
    <>
      <Form.Item
        label="Display name"
        name="displayName"
        rules={[{ max: 80, message: "Keep name under 80 characters" }]}
      >
        <Input placeholder="e.g. HN Headlines" />
      </Form.Item>
      <Form.Item
        label="Target URL"
        name="url"
        rules={[{ required: true, message: "Please provide a URL" }]}
      >
        <Input placeholder="https://news.example.com" />
      </Form.Item>
      <Form.Item label="Keywords" name="keywords">
        <Select mode="tags" placeholder="Add keywords" />
      </Form.Item>
      <Form.Item label="Time range" name="timeRange">
        <DatePicker.RangePicker
          allowClear
          showTime
          style={{ width: "100%" }}
          disabledDate={(date) => date && date > dayjs()}
        />
      </Form.Item>
      <Form.Item label="Concurrency" name="concurrency">
        <InputNumber
          min={1}
          max={10}
          style={{ width: "100%" }}
          placeholder="Default: 3"
        />
      </Form.Item>
      <Form.Item
        label="Include images"
        name="includeImages"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Store media assets"
        name="storeMedia"
        valuePropName="checked"
        extra="Persist Crawl4AI's result.media payload and download up to 6 inline assets (tunable via CRAWL_MEDIA_* envs)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Only main content"
        name="onlyMainContent"
        valuePropName="checked"
      >
        <Switch defaultChecked />
      </Form.Item>
      <Form.Item
        label="Extract links"
        name="extractLinks"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Exclude external images"
        name="excludeExternalImages"
        valuePropName="checked"
        extra="Keep remote images/videos from partner CDNs by turning this off."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Wait for images"
        name="waitForImages"
        valuePropName="checked"
        extra="Ensures hero images and videos render before extraction—recommended when storing media."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Full-page scanning"
        name="scanFullPage"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      <Form.Item label="Scroll delay (ms)" name="scrollDelayMs">
        <InputNumber
          min={0}
          max={5000}
          style={{ width: "100%" }}
          placeholder="Default: 200"
          disabled={!scanFullPage}
        />
      </Form.Item>
      <Form.Item
        label="Dynamic viewport adjustment"
        name="adjustViewportToContent"
        valuePropName="checked"
        extra={
          <span>
            Auto-resize the browser viewport to fit responsive layouts per{" "}
            <Typography.Link
              href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/blog/releases/0.4.1.md"
              target="_blank"
              rel="noreferrer"
            >
              Crawl4AI 0.4.1
            </Typography.Link>
            .
          </span>
        }
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Simulate user actions"
        name="simulateUser"
        valuePropName="checked"
        extra="Adds cursor movement / delays to mimic humans"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Override navigator()"
        name="overrideNavigator"
        valuePropName="checked"
        extra="Spoofs browser navigator properties"
      >
        <Switch />
      </Form.Item>
      <Card
        title="Dynamic crawling (JS + wait)"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/session-management.md"
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Inject custom JavaScript (e.g., click & scroll) and block until a
          selector or async JS condition resolves before Crawl4AI captures the
          HTML snapshot.
        </Typography.Paragraph>
        <Form.List name="jsCode">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: "100%" }}>
              {fields.map((field, index) => (
                <Space key={field.key} align="start">
                  <Form.Item
                    {...field}
                    label={`JS step ${index + 1}`}
                    style={{ flex: 1 }}
                    rules={[
                      { required: true, message: "Provide a JS snippet" },
                    ]}
                  >
                    <Input.TextArea
                      rows={3}
                      placeholder="document.querySelector('.load-more')?.click();"
                    />
                  </Form.Item>
                  <Button
                    type="link"
                    danger
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(field.name)}
                  />
                </Space>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                icon={<PlusOutlined />}
                block
              >
                Add JS step
              </Button>
            </Space>
          )}
        </Form.List>
        <Form.Item
          label="JS-only navigation"
          name="jsOnly"
          valuePropName="checked"
          extra="Use when only JS mutations (no fresh navigation) are required."
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label="Wait for selector"
          name="waitForSelector"
          extra="Automatically prefixed with css: when sent to Crawl4AI."
        >
          <Input placeholder=".article-list .item:nth-child(10)" />
        </Form.Item>
        <Form.Item
          label="Wait for JS expression"
          name="waitForScript"
          extra="Provide the body of an async () => boolean function; we add js: for you."
        >
          <Input.TextArea
            rows={3}
            placeholder="() => window.dataLoaded === true"
          />
        </Form.Item>
        <Form.Item
          label="Wait timeout (ms)"
          name="waitForTimeoutMs"
          extra="Defaults to Crawl4AI's internal timeout if left blank."
        >
          <InputNumber
            min={500}
            max={60000}
            style={{ width: "100%" }}
            placeholder="10000"
          />
        </Form.Item>
      </Card>
      <Form.Item
        label="Additional URLs"
        name="additionalUrls"
        extra="Crawl these URLs in the same batch (uses the base strategy unless overridden below)."
      >
        <Select
          mode="tags"
          tokenSeparators={[",", " "]}
          placeholder="https://example.com/archive"
          style={{ width: "100%" }}
        />
      </Form.Item>
      <Form.Item
        label="Markdown source"
        name={["markdownOptions", "contentSource"]}
        extra="Choose which HTML snapshot feeds the Markdown generator."
      >
        <Select
          allowClear
          placeholder="Default: cleaned_html"
          options={[
            { value: "cleaned_html", label: "Cleaned HTML (default)" },
            { value: "raw_html", label: "Raw HTML" },
            { value: "fit_html", label: "Fit HTML (schema optimized)" },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Ignore links"
        name={["markdownOptions", "ignoreLinks"]}
        valuePropName="checked"
        extra="Drop hyperlink references from generated Markdown."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Escape HTML"
        name={["markdownOptions", "escapeHtml"]}
        valuePropName="checked"
        extra="HTML entities remain encoded when enabled."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Body width"
        name={["markdownOptions", "bodyWidth"]}
        extra="Wrap Markdown paragraphs at a custom width."
      >
        <InputNumber
          min={40}
          max={200}
          placeholder="80"
          style={{ width: "100%" }}
        />
      </Form.Item>
      <Form.Item
        label="Markdown filter"
        name={["markdownFilter", "type"]}
        extra="Optionally enable Crawl4AI's content filters (e.g., pruning) before Markdown output."
      >
        <Select
          allowClear
          placeholder="None"
          options={[{ value: "pruning", label: "PruningContentFilter" }]}
        />
      </Form.Item>
      <Form.Item
        label="Pruning threshold"
        name={["markdownFilter", "threshold"]}
        hidden={markdownFilterType !== "pruning"}
        extra="Keep content whose relevance score is above this threshold (0-1)."
      >
        <InputNumber
          min={0}
          max={1}
          step={0.05}
          style={{ width: "100%" }}
          placeholder="0.6"
        />
      </Form.Item>
      <Form.Item
        label="Threshold mode"
        name={["markdownFilter", "thresholdType"]}
        hidden={markdownFilterType !== "pruning"}
        extra="Choose between fixed or dynamic heuristics per Crawl4AI Fit Markdown guide."
      >
        <Select
          allowClear
          placeholder="dynamic"
          options={[
            { value: "dynamic", label: "Dynamic (auto adjusts per page)" },
            { value: "fixed", label: "Fixed (use provided score)" },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Min words per block"
        name={["markdownFilter", "minWordThreshold"]}
        hidden={markdownFilterType !== "pruning"}
        extra="Ignore nodes shorter than this count before scoring (Fit Markdown heuristic)."
      >
        <InputNumber
          min={0}
          max={500}
          step={1}
          style={{ width: "100%" }}
          placeholder="5"
        />
      </Form.Item>
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        Custom Markdown strategy
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        Provide the Crawl4AI strategy class name plus optional JSON params per
        the{" "}
        <Typography.Link
          href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/markdown-generation.md#custom-strategies"
          target="_blank"
          rel="noreferrer"
        >
          Custom Strategies guide
        </Typography.Link>
        . Leave blank to use the default generator above.
      </Typography.Paragraph>
      <Form.Item
        label="Strategy type"
        name={["markdownStrategy", "type"]}
        extra="Matches the Python class registered with Crawl4AI (e.g. MyMarkdownGenerator)."
      >
        <Input placeholder="MyMarkdownGenerator" maxLength={128} />
      </Form.Item>
      <Form.Item
        label="Params (JSON)"
        name={["markdownStrategy", "params"]}
        extra="Arbitrary JSON object passed verbatim to your strategy constructor."
      >
        <Input.TextArea
          rows={4}
          placeholder='{ "content_source": "raw_html" }'
        />
      </Form.Item>
      <Card
        size="small"
        title="Clean Markdown"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/content-selection.md"
            target="_blank"
            rel="noreferrer"
          >
            crawl4ai docs
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Mirror Crawl4AI&apos;s Clean Markdown recipe to strip nav/footer
          blocks, remove overlays, and drop short fragments for accurately
          formatted Markdown output (per the{" "}
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/examples/quickstart.ipynb"
            target="_blank"
            rel="noreferrer"
          >
            official quickstart
          </Typography.Link>
          ).
        </Typography.Paragraph>
        <Form.Item
          label="Scoped CSS selector"
          name={["cleanMarkdown", "cssSelector"]}
          extra="Limit Markdown to a single region (e.g. #main-content)."
        >
          <Input placeholder="#main-content" maxLength={512} />
        </Form.Item>
        <Form.Item
          label="Target elements"
          name={["cleanMarkdown", "targetElements"]}
          extra="Provide multiple selectors for multi-column layouts."
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " "]}
            placeholder=".article, .sidebar"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label="Excluded tags"
          name={["cleanMarkdown", "excludedTags"]}
          extra="Drop repeating chrome such as nav, footer, form, aside."
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " "]}
            placeholder="nav, footer, aside"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label="Remove overlay elements"
          name={["cleanMarkdown", "removeOverlayElements"]}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label="Word count threshold"
          name={["cleanMarkdown", "wordCountThreshold"]}
          extra="Ignore fragments below this number of words."
        >
          <InputNumber
            min={0}
            max={2000}
            placeholder="10"
            style={{ width: "100%" }}
          />
        </Form.Item>
      </Card>
      <Card
        size="small"
        title="Enhanced table extraction"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/blog/release-v0.7.3.md"
            target="_blank"
            rel="noreferrer"
          >
            crawl4ai docs
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Leverages Crawl4AI&apos;s{" "}
          <em>
            Enhanced Table Extraction: Direct DataFrame conversion from web
            tables
          </em>{" "}
          release (v0.7.3+) so every crawl can detect HTML tables, stream them
          into DataFrame-ready records, and expose captions/source metadata for
          downstream analytics.
        </Typography.Paragraph>
        <Form.Item
          label="Table score threshold"
          name="tableScoreThreshold"
          extra="Controls CrawlerRunConfig.table_score_threshold (0-10). Higher scores keep only confident tables."
        >
          <InputNumber
            min={0}
            max={10}
            step={0.1}
            placeholder="7"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label="Strategy type"
          name={["tableExtraction", "type"]}
          extra="Default to DefaultTableExtraction for min row/column control or switch to LLMTableExtraction for complex layouts."
        >
          <Input placeholder="DefaultTableExtraction" maxLength={128} />
        </Form.Item>
        <Form.Item
          label="Min rows"
          name={["tableExtraction", "minRows"]}
          extra="Maps to DefaultTableExtraction.min_rows to filter out small snippets."
        >
          <InputNumber
            min={1}
            max={1000}
            style={{ width: "100%" }}
            placeholder="2"
          />
        </Form.Item>
        <Form.Item
          label="Min columns"
          name={["tableExtraction", "minCols"]}
          extra="Maps to DefaultTableExtraction.min_cols."
        >
          <InputNumber
            min={1}
            max={50}
            style={{ width: "100%" }}
            placeholder="2"
          />
        </Form.Item>
        <Form.Item
          label="Extra params (JSON)"
          name={["tableExtraction", "params"]}
          extra="Optional JSON blob merged into the Crawl4AI strategy params (e.g., chunking or provider overrides)."
        >
          <Input.TextArea
            rows={3}
            placeholder='{ "enable_chunking": true, "max_parallel_chunks": 5 }'
          />
        </Form.Item>
      </Card>
      <Card size="small" title="Link analysis" style={{ marginBottom: 16 }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Enable Crawl4AI LinkPreviewConfig to pull internal/external links with
          quality scores.
        </Typography.Paragraph>
        <Form.Item
          label="Score links"
          name="scoreLinks"
          valuePropName="checked"
          extra="Turns on intrinsic/contextual scoring for extracted links."
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label="Include internal links"
          name={["linkPreview", "includeInternal"]}
          valuePropName="checked"
        >
          <Switch disabled={linkPreviewDisabled} />
        </Form.Item>
        <Form.Item
          label="Include external links"
          name={["linkPreview", "includeExternal"]}
          valuePropName="checked"
        >
          <Switch disabled={linkPreviewDisabled} />
        </Form.Item>
        <Form.Item
          label="Include social media"
          name={["linkPreview", "includeSocial"]}
          valuePropName="checked"
        >
          <Switch disabled={linkPreviewDisabled} />
        </Form.Item>
        <Form.Item label="Max links" name={["linkPreview", "maxLinks"]}>
          <InputNumber
            min={1}
            max={500}
            style={{ width: "100%" }}
            placeholder="200"
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item label="Concurrency" name={["linkPreview", "concurrency"]}>
          <InputNumber
            min={1}
            max={50}
            style={{ width: "100%" }}
            placeholder="10"
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item label="Timeout (s)" name={["linkPreview", "timeoutSeconds"]}>
          <InputNumber
            min={1}
            max={60}
            style={{ width: "100%" }}
            placeholder="5"
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item label="Context query" name={["linkPreview", "query"]}>
          <Input
            placeholder="machine learning tutorials"
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item
          label="Score threshold"
          name={["linkPreview", "scoreThreshold"]}
        >
          <InputNumber
            min={0}
            max={1}
            step={0.05}
            style={{ width: "100%" }}
            placeholder="0.3"
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item
          label="Verbose logging"
          name={["linkPreview", "verbose"]}
          valuePropName="checked"
        >
          <Switch disabled={linkPreviewDisabled} />
        </Form.Item>
        <Form.Item
          label="Include patterns"
          name={["linkPreview", "includePatterns"]}
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " "]}
            placeholder="*/docs/*"
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
        <Form.Item
          label="Exclude patterns"
          name={["linkPreview", "excludePatterns"]}
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " "]}
            placeholder="*/login*"
            disabled={linkPreviewDisabled}
          />
        </Form.Item>
      </Card>
      <Form.List name="multiUrlConfigs">
        {(fields, { add, remove }) => (
          <Space direction="vertical" style={{ width: "100%" }} size="large">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Typography.Text strong>Multi-URL strategies</Typography.Text>
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => add()}
                size="small"
              >
                Add strategy
              </Button>
            </div>
            {fields.length === 0 ? (
              <Typography.Text type="secondary">
                Optional: match additional URL patterns to custom crawler
                settings.
              </Typography.Text>
            ) : null}
            {fields.map((field, index) => (
              <Card
                key={field.key}
                size="small"
                title={`Strategy ${index + 1}`}
                extra={
                  <Button
                    type="link"
                    danger
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(field.name)}
                  >
                    Remove
                  </Button>
                }
              >
                <Form.Item label="Label" name={[field.name, "name"]}>
                  <Input placeholder="e.g. PDF files" />
                </Form.Item>
                <Form.Item
                  label="Match mode"
                  name={[field.name, "matcher", "matchMode"]}
                  extra="Controls how patterns below are interpreted."
                >
                  <Select
                    allowClear
                    placeholder="glob (default)"
                    options={[
                      { value: "glob", label: "Glob (*.pdf)" },
                      { value: "regex", label: "Regex" },
                      { value: "substring", label: "Substring" },
                      { value: "prefix", label: "Prefix" },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  label="URL patterns"
                  name={[field.name, "matcher", "patterns"]}
                  rules={[
                    {
                      validator: (_, value) => {
                        if (!value || value.length === 0) {
                          return Promise.resolve();
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Select
                    mode="tags"
                    tokenSeparators={[",", " "]}
                    placeholder="*.pdf"
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item
                  label="Explicit URLs"
                  name={[field.name, "urls"]}
                  extra="Optional explicit URLs that should use this strategy."
                >
                  <Select
                    mode="tags"
                    tokenSeparators={[",", " "]}
                    placeholder="https://example.com/report.pdf"
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item
                  label="Cache mode"
                  name={[field.name, "options", "cacheMode"]}
                >
                  <Select
                    allowClear
                    placeholder="Default (bypass)"
                    options={[
                      { value: "bypass", label: "Bypass (fresh)" },
                      { value: "prefer_cache", label: "Prefer cache" },
                      { value: "force_cache", label: "Force cache" },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  label="Full-page scanning"
                  name={[field.name, "options", "scanFullPage"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label="Scroll delay (ms)"
                  name={[field.name, "options", "scrollDelayMs"]}
                >
                  <InputNumber
                    min={0}
                    max={5000}
                    style={{ width: "100%" }}
                    placeholder="Default: 200"
                  />
                </Form.Item>
                <Form.Item
                  label="Dynamic viewport adjustment"
                  name={[field.name, "options", "adjustViewportToContent"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label="Only main content"
                  name={[field.name, "options", "onlyMainContent"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label="Extract links"
                  name={[field.name, "options", "extractLinks"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label="Simulate user actions"
                  name={[field.name, "options", "simulateUser"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label="Override navigator()"
                  name={[field.name, "options", "overrideNavigator"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Typography.Text
                  strong
                  style={{ marginBottom: 8, display: "block" }}
                >
                  Dynamic crawling overrides
                </Typography.Text>
                <Form.List name={[field.name, "options", "jsCode"]}>
                  {(jsFields, { add: addJs, remove: removeJs }) => (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      {jsFields.map((jsField, jsIndex) => (
                        <Space key={jsField.key} align="start">
                          <Form.Item
                            {...jsField}
                            label={`JS step ${jsIndex + 1}`}
                            style={{ flex: 1 }}
                          >
                            <Input.TextArea
                              rows={2}
                              placeholder="document.querySelector('.load-more')?.click();"
                            />
                          </Form.Item>
                          <Button
                            type="link"
                            danger
                            icon={<MinusCircleOutlined />}
                            onClick={() => removeJs(jsField.name)}
                          />
                        </Space>
                      ))}
                      <Button
                        type="dashed"
                        icon={<PlusOutlined />}
                        onClick={() => addJs()}
                      >
                        Add JS step
                      </Button>
                    </Space>
                  )}
                </Form.List>
                <Form.Item
                  label="JS-only navigation"
                  name={[field.name, "options", "jsOnly"]}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Form.Item
                  label="Wait for selector"
                  name={[field.name, "options", "waitForSelector"]}
                >
                  <Input placeholder=".feed > article:last-child" />
                </Form.Item>
                <Form.Item
                  label="Wait for JS expression"
                  name={[field.name, "options", "waitForScript"]}
                >
                  <Input.TextArea
                    rows={2}
                    placeholder="() => document.querySelectorAll(...).length > 20"
                  />
                </Form.Item>
                <Form.Item
                  label="Wait timeout (ms)"
                  name={[field.name, "options", "waitForTimeoutMs"]}
                >
                  <InputNumber
                    min={500}
                    max={60000}
                    style={{ width: "100%" }}
                    placeholder="10000"
                  />
                </Form.Item>
              </Card>
            ))}
          </Space>
        )}
      </Form.List>
    </>
  );
}

interface BrowserConfigFormProps {
  userAgentModeValue?: string;
  useManagedBrowserValue?: boolean;
  proxyUrlActive: boolean;
  proxyObjectActive: boolean;
}

function BrowserConfigForm({
  userAgentModeValue,
  useManagedBrowserValue,
  proxyUrlActive,
  proxyObjectActive,
}: BrowserConfigFormProps) {
  return (
    <>
      <Form.Item
        label="Undetected browser"
        name="enableUndetectedBrowser"
        valuePropName="checked"
        extra="Bypasses bot detection using Crawl4AI's UndetectedAdapter"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Stealth mode"
        name="enableStealthMode"
        valuePropName="checked"
        extra="Tweaks browser fingerprints for basic evasion"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Managed browser"
        name="useManagedBrowser"
        valuePropName="checked"
        extra={
          <span>
            Reuse your own browser session per
            <Typography.Link
              href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/identity-based-crawling.md"
              target="_blank"
              rel="noreferrer"
              style={{ marginLeft: 4 }}
            >
              Crawl4AI managed browser docs
            </Typography.Link>
            .
          </span>
        }
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="User data directory"
        name="userDataDir"
        extra="Absolute path to your Chrome/Edge profile (e.g. ~/.config/chrome-profile)."
      >
        <Input
          placeholder="/home/me/.crawl4ai/profiles/news"
          disabled={!useManagedBrowserValue}
        />
      </Form.Item>
      <Card
        title="Browser identity"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/core/browser-crawler-config.md"
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Override Crawl4AI&apos;s BrowserConfig to send first-party cookies,
          custom headers, and rotating user agents for harder-to-detect crawls.
        </Typography.Paragraph>
        <Form.Item
          label="Custom user agent"
          name="userAgent"
          extra="Leave blank to reuse Crawl4AI defaults."
        >
          <Input placeholder="Mozilla/5.0 ..." maxLength={768} />
        </Form.Item>
        <Form.Item
          label="User agent mode"
          name="userAgentMode"
          extra="Enable Crawl4AI's random generator for every navigation."
        >
          <Select
            allowClear
            placeholder="Default (static)"
            options={[{ value: "random", label: "Random rotation" }]}
          />
        </Form.Item>
        <Form.Item
          label="Generator platform"
          name={["userAgentGenerator", "platform"]}
        >
          <Select
            allowClear
            placeholder="windows / macos / linux / android / ios"
            disabled={userAgentModeValue !== "random"}
            options={[
              { value: "windows", label: "Windows" },
              { value: "macos", label: "macOS" },
              { value: "linux", label: "Linux" },
              { value: "android", label: "Android" },
              { value: "ios", label: "iOS" },
            ]}
          />
        </Form.Item>
        <Form.Item
          label="Generator browser"
          name={["userAgentGenerator", "browser"]}
        >
          <Select
            allowClear
            placeholder="chrome / firefox / safari / edge"
            disabled={userAgentModeValue !== "random"}
            options={[
              { value: "chrome", label: "Chrome" },
              { value: "firefox", label: "Firefox" },
              { value: "safari", label: "Safari" },
              { value: "edge", label: "Edge" },
            ]}
          />
        </Form.Item>
        <Form.Item
          label="Generator device"
          name={["userAgentGenerator", "deviceType"]}
        >
          <Select
            allowClear
            placeholder="desktop / mobile / tablet"
            disabled={userAgentModeValue !== "random"}
            options={[
              { value: "desktop", label: "Desktop" },
              { value: "mobile", label: "Mobile" },
              { value: "tablet", label: "Tablet" },
            ]}
          />
        </Form.Item>
        <Form.Item
          label="Generator locale"
          name={["userAgentGenerator", "locale"]}
          extra="Overrides Accept-Language inside the rotating agent."
        >
          <Input
            placeholder="en-US"
            maxLength={16}
            disabled={userAgentModeValue !== "random"}
          />
        </Form.Item>
        <Form.Item
          label="Browser locale"
          name="locale"
          extra="Sets navigator.language and Accept-Language headers."
        >
          <Input placeholder="en-US" maxLength={16} />
        </Form.Item>
        <Form.Item
          label="Timezone ID"
          name="timezoneId"
          extra="IANA timezone applied to the Playwright context."
        >
          <Input placeholder="America/New_York" maxLength={64} />
        </Form.Item>
        <Form.Item
          label="Geolocation"
          extra="Latitude / longitude (optional accuracy in meters) forwarded to the browser context."
        >
          <Space wrap>
            <Form.Item name={["geolocation", "latitude"]} noStyle>
              <InputNumber
                placeholder="Latitude"
                min={-90}
                max={90}
                step={0.1}
                style={{ width: 140 }}
              />
            </Form.Item>
            <Form.Item name={["geolocation", "longitude"]} noStyle>
              <InputNumber
                placeholder="Longitude"
                min={-180}
                max={180}
                step={0.1}
                style={{ width: 140 }}
              />
            </Form.Item>
            <Form.Item name={["geolocation", "accuracy"]} noStyle>
              <InputNumber
                placeholder="Accuracy"
                min={1}
                max={5000}
                step={1}
                style={{ width: 140 }}
              />
            </Form.Item>
          </Space>
        </Form.Item>
        <Typography.Title level={5} style={{ marginTop: 16 }}>
          Custom headers
        </Typography.Title>
        <Form.List name="browserHeaders">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: "100%" }}>
              {fields.map((field) => (
                <Space
                  key={field.key}
                  align="baseline"
                  style={{ width: "100%" }}
                >
                  <Form.Item name={[field.name, "name"]} style={{ flex: 1 }}>
                    <Input placeholder="Header name" />
                  </Form.Item>
                  <Form.Item name={[field.name, "value"]} style={{ flex: 2 }}>
                    <Input placeholder="Header value" />
                  </Form.Item>
                  <Button
                    type="text"
                    icon={<MinusCircleOutlined />}
                    danger
                    onClick={() => remove(field.name)}
                  />
                </Space>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                icon={<PlusOutlined />}
                block
              >
                Add header
              </Button>
            </Space>
          )}
        </Form.List>
        <Typography.Title level={5} style={{ marginTop: 24 }}>
          Cookies
        </Typography.Title>
        <Form.List name="browserCookies">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: "100%" }}>
              {fields.map((field) => (
                <Space
                  key={field.key}
                  align="baseline"
                  style={{ width: "100%" }}
                >
                  <Form.Item name={[field.name, "name"]} style={{ flex: 1 }}>
                    <Input placeholder="Name" />
                  </Form.Item>
                  <Form.Item name={[field.name, "value"]} style={{ flex: 2 }}>
                    <Input placeholder="Value" />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, "domain"]}
                    style={{ flex: 1.3 }}
                  >
                    <Input placeholder="example.com" />
                  </Form.Item>
                  <Form.Item name={[field.name, "path"]} style={{ flex: 1 }}>
                    <Input placeholder="/" />
                  </Form.Item>
                  <Button
                    type="text"
                    icon={<MinusCircleOutlined />}
                    danger
                    onClick={() => remove(field.name)}
                  />
                </Space>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                icon={<PlusOutlined />}
                block
              >
                Add cookie
              </Button>
            </Space>
          )}
        </Form.List>
      </Card>
      <Card
        title="Session management"
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Typography.Link
            href="https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/advanced/session-management.md"
            target="_blank"
            rel="noreferrer"
          >
            Docs
          </Typography.Link>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Provide a Crawl4AI session identifier to reuse the same browser tab
          across multiple requests, and optionally preload cookies/localStorage
          via a storage_state JSON blob (or a path on the Crawl4AI host).
        </Typography.Paragraph>
        <Form.Item
          label="Session ID"
          name="sessionId"
          extra="Add a human-friendly ID (letters, numbers, hyphen) to reuse this browser state later."
        >
          <Input placeholder="e.g. newsroom-auth-session" maxLength={160} />
        </Form.Item>
        <Form.Item
          label="Storage state (JSON or path)"
          name="storageState"
          extra="Paste Crawl4AI storage_state JSON (cookies/localStorage) or provide an absolute path accessible to the crawler."
        >
          <Input.TextArea
            rows={4}
            placeholder='{ "cookies": [...] }'
            maxLength={12000}
          />
        </Form.Item>
      </Card>
      <Card title="Proxy" size="small" style={{ marginBottom: 16 }}>
        <Form.Item
          label="Proxy URL"
          name="proxyUrl"
          extra="Send a single proxy string (e.g. http://user:pass@proxy:8080 or socks5://proxy:1080)."
        >
          <Input
            placeholder="http://proxy.example.com:8080"
            disabled={proxyObjectActive}
          />
        </Form.Item>
        <Form.Item
          label="Proxy server"
          name={["proxyConfig", "server"]}
          extra="Dict format from Crawl4AI v0.7.4+; fill this when the proxy requires separate auth fields."
        >
          <Input
            placeholder="http://proxy.example.com:8080"
            disabled={proxyUrlActive}
          />
        </Form.Item>
        <Form.Item label="Proxy username" name={["proxyConfig", "username"]}>
          <Input placeholder="Optional username" disabled={proxyUrlActive} />
        </Form.Item>
        <Form.Item label="Proxy password" name={["proxyConfig", "password"]}>
          <Input.Password
            placeholder="Optional password"
            disabled={proxyUrlActive}
          />
        </Form.Item>
      </Card>
    </>
  );
}
