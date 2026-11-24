/**
 * Seed the Config table with the default WhatsApp templates and settings.
 *
 *   npm run seed                      # dev stage, keeps existing rows
 *   npm run seed -- --stage prod
 *   npm run seed -- --force           # overwrite templates/settings with defaults
 *   npm run seed -- --business-number "+94 70 345 6789"
 */
import { stackOutputs, argValue } from './outputs';

async function main() {
  const outputs = await stackOutputs();
  if (!outputs.ConfigTableName) throw new Error('ConfigTableName output not found — deploy the stack first.');
  process.env.CONFIG_TABLE = outputs.ConfigTableName;

  // Import after CONFIG_TABLE is set (db.ts reads it at module load).
  const { putTemplate, putStoredSettings } = await import('../src/shared/db');
  const { DEFAULT_TEMPLATES } = await import('../src/shared/templates');
  const { DEFAULT_SETTINGS } = await import('../src/shared/settings');

  const force = process.argv.includes('--force');

  for (const template of DEFAULT_TEMPLATES) {
    const written = await putTemplate(template, force);
    console.log(`${written ? '✔ wrote ' : '• kept  '} template ${template.templateId}`);
  }

  const businessNumber = argValue('--business-number');
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(businessNumber ? { whatsappBusinessNumber: businessNumber } : {}),
  };
  const written = await putStoredSettings(settings, force);
  console.log(`${written ? '✔ wrote ' : '• kept  '} settings`);
  console.log(`\nSeeded ${outputs.ConfigTableName}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
