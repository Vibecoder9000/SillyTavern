import { jest } from '@jest/globals';

jest.unstable_mockModule('../public/lib.js', () => ({
    DOMPurify: { sanitize: value => value },
}));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: {},
    POPUP_RESULT: {},
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((acc, str, i) => acc + str + (values[i] ?? ''), ''),
}));

const { escapeHtml, groupAntSeedOffers, normalizeAntSeedModels } = await import('../public/scripts/antseed.js');

const fixture = {
    data: [
        {
            id: 'model-a',
            name: 'Model A',
            aliases: ['A'],
            peers: [
                { peerId: 'peer-x', displayName: 'Provider X', serviceId: 'model-a', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5, effectiveReputationScore: 9.1 },
                { peerId: 'peer-y', displayName: 'Shared Name', serviceId: 'model-a', inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.6, effectiveReputationScore: 8.5 },
            ],
        },
        {
            id: 'model-b',
            name: 'Model B',
            peers: [
                { peerId: 'peer-x', displayName: 'Provider X', serviceId: 'model-b', inputUsdPerMillion: 0.3, outputUsdPerMillion: 0.7, effectiveReputationScore: 9.1 },
                { peerId: 'peer-z', displayName: 'Shared Name', serviceId: 'model-b', inputUsdPerMillion: 0.4, outputUsdPerMillion: 0.8, effectiveReputationScore: 8.2 },
            ],
        },
    ],
};

test('normalizes model and provider identity from their respective hierarchy levels', () => {
    const offers = normalizeAntSeedModels(fixture);

    expect(offers.map(offer => [offer.modelId, offer.modelName, offer.peerId, offer.providerName])).toEqual([
        ['model-a', 'Model A', 'peer-x', 'Provider X'],
        ['model-a', 'Model A', 'peer-y', 'Shared Name'],
        ['model-b', 'Model B', 'peer-x', 'Provider X'],
        ['model-b', 'Model B', 'peer-z', 'Shared Name'],
    ]);
});

test('groups models by modelId and providers by peerId', () => {
    const providers = groupAntSeedOffers(normalizeAntSeedModels(fixture)).providers;
    const models = groupAntSeedOffers(normalizeAntSeedModels(fixture)).models;

    expect(models.map(model => [model.modelName, model.offers.map(offer => offer.providerName)])).toEqual([
        ['Model A', ['Provider X', 'Shared Name']],
        ['Model B', ['Provider X', 'Shared Name']],
    ]);
    expect(providers.map(provider => [provider.peerId, provider.providerName, provider.modelsCount])).toEqual([
        ['peer-x', 'Provider X', 2],
        ['peer-y', 'Shared Name', 1],
        ['peer-z', 'Shared Name', 1],
    ]);
});

test('uses nested service identity and deduplicates by selectable offer key', () => {
    const offers = normalizeAntSeedModels({
        data: [{
            id: 'model-a',
            name: 'Model A',
            peers: [{
                peerId: 'peer-x',
                displayName: 'Provider X',
                services: [
                    { serviceId: 'service-a', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 },
                    { serviceId: 'service-a', inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.6 },
                    { serviceId: 'service-b', inputUsdPerMillion: 0.3, outputUsdPerMillion: 0.7 },
                ],
            }],
        }],
    });

    expect(offers.map(offer => [offer.offerKey, offer.serviceId])).toEqual([
        ['peer-x@service-a', 'service-a'],
        ['peer-x@service-b', 'service-b'],
    ]);
});

test('normalizes contextLength and maxOutputTokens from peer capabilities and model fallbacks', () => {
    const offers = normalizeAntSeedModels({
        data: [{
            id: 'model-ctx',
            name: 'Model Context',
            context_length: 8192,
            max_output_tokens: 2048,
            peers: [
                {
                    peerId: 'peer-cap',
                    displayName: 'Provider Cap',
                    capabilities: { contextWindow: 32768, maxOutputTokens: 4096 },
                    services: [{ serviceId: 'service-cap', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 }],
                },
                {
                    peerId: 'peer-fallback',
                    displayName: 'Provider Fallback',
                    services: [{ serviceId: 'service-fallback', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 }],
                },
            ],
        }],
    });

    expect(offers.map(offer => [offer.offerKey, offer.contextLength, offer.maxOutputTokens])).toEqual([
        ['peer-cap@service-cap', 32768, 4096],
        ['peer-fallback@service-fallback', 8192, 2048],
    ]);
});

test('settingsToUpdate treats antseed_model as connection setting and excludes antseed_acknowledged_prices', async () => {
    const { readFileSync } = await import('node:fs');
    const openAiScript = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');

    // antseed_model must have 4th element (isConnection) set to true
    expect(openAiScript).toMatch(/antseed_model:\s*\['#antseed_model',\s*'antseed_model',\s*false,\s*true\]/);
    // antseed_acknowledged_prices must not exist in settingsToUpdate
    expect(openAiScript).not.toMatch(/antseed_acknowledged_prices:\s*\[/);
});

test('toggleChatCompletionForms triggers change on #antseed_model', async () => {
    const { readFileSync } = await import('node:fs');
    const openAiScript = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');

    expect(openAiScript).toMatch(/chat_completion_sources\.ANTSEED\)\s*\{\s*refreshAntSeedUI\(\);\s*\$\('#antseed_model'\)\.trigger\('change'\);/);
});

test('custom-request includes antseed_endpoint in overridePayload endpoint fields', async () => {
    const { readFileSync } = await import('node:fs');
    const customReqScript = readFileSync(new URL('../public/scripts/custom-request.js', import.meta.url), 'utf8');

    expect(customReqScript).toMatch(/\['custom_url'[^\]]*'antseed_endpoint'[^\]]*\]\.forEach/);
});

test('slash-commands modelSelectMap includes antseed_model mapping', async () => {
    const { readFileSync } = await import('node:fs');
    const slashCommandsScript = readFileSync(new URL('../public/scripts/slash-commands.js', import.meta.url), 'utf8');

    expect(slashCommandsScript).toMatch(/\{\s*id:\s*'antseed_model',\s*api:\s*'openai',\s*type:\s*chat_completion_sources\.ANTSEED\s*\}/);
});

test('antseed_endpoint listens to input and change events', async () => {
    const { readFileSync } = await import('node:fs');
    const antseedScript = readFileSync(new URL('../public/scripts/antseed.js', import.meta.url), 'utf8');

    expect(antseedScript).toMatch(/\$\('#antseed_endpoint'\)\.on\('input change'/);
});

test('syncAntSeedContext updates companion counter max and preserves context of 0', async () => {
    const { readFileSync } = await import('node:fs');
    const antseedScript = readFileSync(new URL('../public/scripts/antseed.js', import.meta.url), 'utf8');

    // Updates counter max
    expect(antseedScript).toMatch(/\$\('#openai_max_context_counter'\)\.attr\('max',\s*maxContext\)/);
    // Preserves 0 instead of using || maxContext
    expect(antseedScript).not.toMatch(/current\.openai_max_context\s*\|\|\s*maxContext/);
    expect(antseedScript).toMatch(/Number\.isFinite\(Number\(current\.openai_max_context\)\)/);
});

test('slash-commands includes antseed in api-url argument enumList and setApiUrlCallback', async () => {
    const { readFileSync } = await import('node:fs');
    const slashCommandsScript = readFileSync(new URL('../public/scripts/slash-commands.js', import.meta.url), 'utf8');

    expect(slashCommandsScript).toMatch(/new SlashCommandEnumValue\('antseed',\s*'AntSeed'/);
    expect(slashCommandsScript).toMatch(/api === chat_completion_sources\.ANTSEED/);
});

test('ConnectionManagerRequestService.sendRequest forwards antseed_endpoint and checks offer safety', async () => {
    const { readFileSync } = await import('node:fs');
    const sharedScript = readFileSync(new URL('../public/scripts/extensions/shared.js', import.meta.url), 'utf8');

    expect(sharedScript).toMatch(/antseed_endpoint:\s*profile\['api-url'\]/);
    expect(sharedScript).toMatch(/ensureAntSeedOfferSafe/);
});

test('antseed.svg icon exists in public/img', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const iconPath = fileURLToPath(new URL('../public/img/antseed.svg', import.meta.url));

    expect(existsSync(iconPath)).toBe(true);
});

test('escapeHtml escapes quotes, ampersands, and angle brackets for attribute safety', () => {
    expect(escapeHtml('foo" onmouseover="alert(1)" <bar>&\'baz\'')).toBe('foo&quot; onmouseover=&quot;alert(1)&quot; &lt;bar&gt;&amp;&#39;baz&#39;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
});

test('index.html antseed_form includes data-i18n localization attributes', async () => {
    const { readFileSync } = await import('node:fs');
    const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

    expect(indexHtml).toMatch(/<h4 data-i18n="AntSeed Endpoint">/);
    expect(indexHtml).toMatch(/<h4 data-i18n="AntSeed Model">/);
    expect(indexHtml).toMatch(/<div class="antseed-section-label" data-i18n="Selected Offer">/);
    expect(indexHtml).toMatch(/data-i18n="\[placeholder\]Search models or providers"/);
    expect(indexHtml).toMatch(/data-i18n="\[title\]Refresh AntSeed offers;\[aria-label\]Refresh AntSeed offers"/);
});

test('openai.js uses t tag literals for localized antseed error messages', async () => {
    const { readFileSync } = await import('node:fs');
    const openAiScript = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');

    expect(openAiScript).toMatch(/\[\/peer\.\*\(unavailable\|unknown\)\|unknown\.\*peer\/,\s*t`The selected AntSeed peer is unavailable or unknown\.`\]/);
    expect(openAiScript).toMatch(/throw new Error\(result\?\.message\s*\|\|\s*t`The selected AntSeed offer is unknown or unavailable\.`\)/);
});

