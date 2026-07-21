<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
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
  } from './shared/index';
  import { SDK_PACKAGE_NAME, SDK_PACKAGE_VERSION } from './build-info';

  export let src: string | undefined = undefined;
  export let apiKey: string | undefined = undefined;
  export let licenseValidationUrl: string | undefined = undefined;
  export let expectedOrganizationId: string | undefined = undefined;
  export let expectedLicenseId: string | undefined = undefined;
  export let initialHtml: string | undefined = undefined;
  export let mergeTags: MergeTagOption[] | undefined = undefined;
  export let mergeTagTrigger: string | undefined = undefined;
  export let embedToken: string | undefined = undefined;
  export let templateId: string | undefined = undefined;
  export let config: Exclude<BuilderConfig, undefined> | undefined = undefined;
  export let externalFooterHtml: string | undefined = undefined;
  export let footerInjectionMode: 'default' | 'sdk' | undefined = undefined;
  export let theme: ThemeDefinition | undefined = undefined;
  export let themeMode: ThemeMode | undefined = undefined;
  export let tenantId: string | undefined = undefined;
  export let preview: boolean | undefined = undefined;
  export let previewOnly: boolean | undefined = undefined;
  export let hideLoadingOverlay: boolean | undefined = undefined;
  export let iframeTitle: string | undefined = undefined;
  export let sandbox: string | undefined = undefined;
  export let allowedOrigin: string | undefined = undefined;
  export let upload: UploadHandler | undefined = undefined;
  export let listAssets: ListAssetsHandler | undefined = undefined;
  export let deleteAsset: DeleteAssetHandler | undefined = undefined;

  const dispatch = createEventDispatcher<{
    change: string;
    load: string;
    save: string;
    ready: void;
    statusChange: EmailEditorStatus;
    authError: string;
  }>();

  let host: HTMLDivElement;
  let controller: EmailEditorController | null = null;

  onMount(() => {
    controller = createEmailEditorController({
      src,
      apiKey,
      licenseValidationUrl,
      expectedOrganizationId,
      expectedLicenseId,
      initialHtml,
      mergeTags,
      mergeTagTrigger,
      embedToken,
      templateId,
      config,
      externalFooterHtml,
      footerInjectionMode,
      theme,
      themeMode,
      tenantId,
      preview,
      previewOnly,
      hideLoadingOverlay,
      iframeTitle,
      sandbox,
      allowedOrigin,
      onChange: (html) => dispatch('change', html),
      onLoad: (html) => dispatch('load', html),
      onSave: (html) => dispatch('save', html),
      onReady: () => dispatch('ready'),
      onStatusChange: (status) => dispatch('statusChange', status),
      onAuthError: (message) => dispatch('authError', message),
      onUpload: upload,
      onListAssets: listAssets,
      onDeleteAsset: deleteAsset,
      packageName: SDK_PACKAGE_NAME,
      packageVersion: SDK_PACKAGE_VERSION,
    });
    controller.mount(host);
  });

  $: if (controller) {
    controller.stageContentUpdate({
      initialHtml,
      mergeTags,
      mergeTagTrigger,
      templateId,
      config,
      externalFooterHtml,
      footerInjectionMode,
      theme,
      themeMode,
      tenantId,
    });
  }

  onDestroy(() => {
    controller?.destroy();
    controller = null;
  });

  export function reload(): void {
    controller?.reload();
  }
</script>

<div bind:this={host} style="position:relative;width:100%;height:100%"></div>
