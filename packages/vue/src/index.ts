import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type PropType,
} from 'vue';
import {
  createEmailEditorController,
  type BuilderConfig,
  type DeleteAssetHandler,
  type EmailEditorController,
  type EmailEditorStatus,
  type ListAssetsHandler,
  type MergeTagOption,
  type ThemeDefinition,
  type ThemeMode,
  type UploadHandler,
  validateMailLayersLicense,
} from './shared/index';
import { SDK_PACKAGE_NAME, SDK_PACKAGE_VERSION } from './build-info';

export type {
  AssetItem,
  AssetRequestContext,
  BuilderConfig,
  DeleteAssetHandler,
  DeleteAssetPayload,
  EmailEditorStatus,
  ListAssetsHandler,
  ListAssetsPayload,
  MergeTagOption,
  ThemeDefinition,
  ThemeMode,
  ThemeTokens,
  UploadHandler,
  ValidateMailLayersLicenseOptions,
  MailLayersLicenseValidationResponse,
} from './shared/index';
export { validateMailLayersLicense };

export interface MailLayersEmailEditorInstance {
  /** Starts a new iframe handshake using the latest staged content props. */
  reload: () => void;
}

/**
 * Vue 3 component embedding the hosted MailLayers email editor through the
 * secured exact-origin iframe bridge protocol.
 *
 * Authorization props (`apiKey`, `src`, `allowedOrigin`, license bindings) are
 * fixed for the lifetime of the component. Content props are staged reactively
 * and applied only by `reload()`, so they never overwrite a dirty editor.
 */
export const MailLayersEmailEditor = defineComponent({
  name: 'MailLayersEmailEditor',
  props: {
    src: { type: String, required: false, default: undefined },
    apiKey: { type: String, required: false, default: undefined },
    licenseValidationUrl: { type: String, required: false, default: undefined },
    expectedOrganizationId: { type: String, required: false, default: undefined },
    expectedLicenseId: { type: String, required: false, default: undefined },
    initialHtml: { type: String, required: false, default: undefined },
    mergeTags: { type: Array as PropType<MergeTagOption[]>, required: false, default: undefined },
    mergeTagTrigger: { type: String, required: false, default: undefined },
    embedToken: { type: String, required: false, default: undefined },
    templateId: { type: String, required: false, default: undefined },
    config: { type: Object as PropType<Exclude<BuilderConfig, undefined>>, required: false, default: undefined },
    externalFooterHtml: { type: String, required: false, default: undefined },
    footerInjectionMode: { type: String as PropType<'default' | 'sdk'>, required: false, default: undefined },
    theme: { type: Object as PropType<ThemeDefinition>, required: false, default: undefined },
    themeMode: { type: String as PropType<ThemeMode>, required: false, default: undefined },
    tenantId: { type: String, required: false, default: undefined },
    preview: { type: Boolean, required: false, default: undefined },
    previewOnly: { type: Boolean, required: false, default: undefined },
    hideLoadingOverlay: { type: Boolean, required: false, default: undefined },
    iframeTitle: { type: String, required: false, default: undefined },
    sandbox: { type: String, required: false, default: undefined },
    allowedOrigin: { type: String, required: false, default: undefined },
    upload: { type: Function as PropType<UploadHandler>, required: false, default: undefined },
    listAssets: { type: Function as PropType<ListAssetsHandler>, required: false, default: undefined },
    deleteAsset: { type: Function as PropType<DeleteAssetHandler>, required: false, default: undefined },
  },
  emits: {
    change: (html: string) => typeof html === 'string',
    load: (html: string) => typeof html === 'string',
    save: (html: string) => typeof html === 'string',
    ready: () => true,
    'status-change': (status: EmailEditorStatus) => typeof status === 'string',
    'auth-error': (message: string) => typeof message === 'string',
  },
  setup(props, { emit, expose }) {
    const host = ref<HTMLDivElement | null>(null);
    let controller: EmailEditorController | null = null;

    onMounted(() => {
      if (!host.value) {
        return;
      }
      controller = createEmailEditorController({
        src: props.src,
        apiKey: props.apiKey,
        licenseValidationUrl: props.licenseValidationUrl,
        expectedOrganizationId: props.expectedOrganizationId,
        expectedLicenseId: props.expectedLicenseId,
        initialHtml: props.initialHtml,
        mergeTags: props.mergeTags,
        mergeTagTrigger: props.mergeTagTrigger,
        embedToken: props.embedToken,
        templateId: props.templateId,
        config: props.config,
        externalFooterHtml: props.externalFooterHtml,
        footerInjectionMode: props.footerInjectionMode,
        theme: props.theme,
        themeMode: props.themeMode,
        tenantId: props.tenantId,
        preview: props.preview,
        previewOnly: props.previewOnly,
        hideLoadingOverlay: props.hideLoadingOverlay,
        iframeTitle: props.iframeTitle,
        sandbox: props.sandbox,
        allowedOrigin: props.allowedOrigin,
        onChange: (html) => emit('change', html),
        onLoad: (html) => emit('load', html),
        onSave: (html) => emit('save', html),
        onReady: () => emit('ready'),
        onStatusChange: (status) => emit('status-change', status),
        onAuthError: (message) => emit('auth-error', message),
        onUpload: props.upload,
        onListAssets: props.listAssets,
        onDeleteAsset: props.deleteAsset,
        packageName: SDK_PACKAGE_NAME,
        packageVersion: SDK_PACKAGE_VERSION,
      });
      controller.mount(host.value);
    });

    watch(
      () => [
        props.initialHtml,
        props.mergeTags,
        props.mergeTagTrigger,
        props.templateId,
        props.config,
        props.externalFooterHtml,
        props.footerInjectionMode,
        props.theme,
        props.themeMode,
        props.tenantId,
      ],
      () => {
        controller?.stageContentUpdate({
          initialHtml: props.initialHtml,
          mergeTags: props.mergeTags,
          mergeTagTrigger: props.mergeTagTrigger,
          templateId: props.templateId,
          config: props.config,
          externalFooterHtml: props.externalFooterHtml,
          footerInjectionMode: props.footerInjectionMode,
          theme: props.theme,
          themeMode: props.themeMode,
          tenantId: props.tenantId,
        });
      },
      { deep: true },
    );

    onBeforeUnmount(() => {
      controller?.destroy();
      controller = null;
    });

    expose({
      reload: () => controller?.reload(),
    } satisfies MailLayersEmailEditorInstance);

    return () =>
      h('div', {
        ref: host,
        style: { position: 'relative', width: '100%', height: '100%' },
      });
  },
});

export default MailLayersEmailEditor;
