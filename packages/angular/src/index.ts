import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NgModule,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
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
export { validateMailLayersLicense } from './shared/index';

/**
 * Angular standalone component embedding the hosted MailLayers email editor
 * through the secured exact-origin iframe bridge protocol.
 */
@Component({
  selector: 'maillayers-email-editor',
  standalone: true,
  template: '<div #host style="position:relative;width:100%;height:100%"></div>',
})
export class MailLayersEmailEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('host', { static: true }) hostRef!: ElementRef<HTMLDivElement>;

  @Input() src?: string;
  @Input() apiKey?: string;
  @Input() licenseValidationUrl?: string;
  @Input() expectedOrganizationId?: string;
  @Input() expectedLicenseId?: string;
  @Input() initialHtml?: string;
  @Input() mergeTags?: MergeTagOption[];
  @Input() mergeTagTrigger?: string;
  @Input() embedToken?: string;
  @Input() templateId?: string;
  @Input() config?: Exclude<BuilderConfig, undefined>;
  @Input() externalFooterHtml?: string;
  @Input() footerInjectionMode?: 'default' | 'sdk';
  @Input() theme?: ThemeDefinition;
  @Input() themeMode?: ThemeMode;
  @Input() tenantId?: string;
  @Input() preview?: boolean;
  @Input() previewOnly?: boolean;
  @Input() hideLoadingOverlay?: boolean;
  @Input() iframeTitle?: string;
  @Input() sandbox?: string;
  @Input() allowedOrigin?: string;
  @Input() upload?: UploadHandler;
  @Input() listAssets?: ListAssetsHandler;
  @Input() deleteAsset?: DeleteAssetHandler;

  @Output() readonly change = new EventEmitter<string>();
  @Output() readonly load = new EventEmitter<string>();
  @Output() readonly save = new EventEmitter<string>();
  @Output() readonly ready = new EventEmitter<void>();
  @Output() readonly statusChange = new EventEmitter<EmailEditorStatus>();
  @Output() readonly authError = new EventEmitter<string>();

  private controller: EmailEditorController | null = null;

  ngAfterViewInit(): void {
    this.controller = createEmailEditorController({
      src: this.src,
      apiKey: this.apiKey,
      licenseValidationUrl: this.licenseValidationUrl,
      expectedOrganizationId: this.expectedOrganizationId,
      expectedLicenseId: this.expectedLicenseId,
      initialHtml: this.initialHtml,
      mergeTags: this.mergeTags,
      mergeTagTrigger: this.mergeTagTrigger,
      embedToken: this.embedToken,
      templateId: this.templateId,
      config: this.config,
      externalFooterHtml: this.externalFooterHtml,
      footerInjectionMode: this.footerInjectionMode,
      theme: this.theme,
      themeMode: this.themeMode,
      tenantId: this.tenantId,
      preview: this.preview,
      previewOnly: this.previewOnly,
      hideLoadingOverlay: this.hideLoadingOverlay,
      iframeTitle: this.iframeTitle,
      sandbox: this.sandbox,
      allowedOrigin: this.allowedOrigin,
      onChange: (html) => this.change.emit(html),
      onLoad: (html) => this.load.emit(html),
      onSave: (html) => this.save.emit(html),
      onReady: () => this.ready.emit(),
      onStatusChange: (status) => this.statusChange.emit(status),
      onAuthError: (message) => this.authError.emit(message),
      onUpload: this.upload,
      onListAssets: this.listAssets,
      onDeleteAsset: this.deleteAsset,
      packageName: SDK_PACKAGE_NAME,
      packageVersion: SDK_PACKAGE_VERSION,
    });
    this.controller.mount(this.hostRef.nativeElement);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.controller) {
      return;
    }
    const contentKeys = [
      'initialHtml', 'mergeTags', 'mergeTagTrigger', 'templateId', 'config',
      'externalFooterHtml', 'footerInjectionMode', 'theme', 'themeMode', 'tenantId',
    ];
    if (!contentKeys.some((key) => key in changes)) {
      return;
    }
    this.controller.stageContentUpdate({
      initialHtml: this.initialHtml,
      mergeTags: this.mergeTags,
      mergeTagTrigger: this.mergeTagTrigger,
      templateId: this.templateId,
      config: this.config,
      externalFooterHtml: this.externalFooterHtml,
      footerInjectionMode: this.footerInjectionMode,
      theme: this.theme,
      themeMode: this.themeMode,
      tenantId: this.tenantId,
    });
  }

  /** Starts a new iframe handshake using the latest staged content inputs. */
  reload(): void {
    this.controller?.reload();
  }

  ngOnDestroy(): void {
    this.controller?.destroy();
    this.controller = null;
  }
}

@NgModule({
  imports: [MailLayersEmailEditorComponent],
  exports: [MailLayersEmailEditorComponent],
})
export class MailLayersEmailEditorModule {}
