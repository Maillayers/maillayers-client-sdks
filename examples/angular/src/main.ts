import { MailLayersEmailEditorComponent } from '@maillayers/angular-email-editor';

const apiKey = import.meta.env.VITE_MAILLAYERS_API_KEY as string | undefined;
const host = document.getElementById('app');
if (host) {
  const component = new MailLayersEmailEditorComponent();
  component.apiKey = apiKey;
  component.initialHtml = '<h1>Angular MailLayers Example</h1><p>Edit this template.</p>';
  component.hostRef = { nativeElement: host };
  component.ngAfterViewInit();
}
