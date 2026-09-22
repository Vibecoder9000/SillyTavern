import { DOMPurify } from '../lib.js';
import { Popup, POPUP_RESULT } from './popup.js';
import { t } from './i18n.js';

export const ANTSEED_DEFAULT_ENDPOINT = 'http://localhost:8377/v1';

const PRICE_FIELDS = ['inputUsdPerMillion', 'outputUsdPerMillion', 'cachedInputUsdPerMillion'];
const state = {
    getSettings: null,
    saveSettings: null,
    refresh: null,
    offers: [],
    models: [],
    providers: [],
    mode: 'models',
    query: '',
    activeModelId: null,
    activePeerId: null,
    modelMasterSort: { key: 'modelName', direction: 1 },
    modelDetailSort: { key: 'estimatedCost', direction: 1 },
    providerMasterSort: { key: 'effectiveReputation', direction: -1 },
    providerDetailSort: { key: 'modelName', direction: 1 },
    refreshTimer: null,
    pendingPriceDialog: null,
    modelInputTimer: null,
    endpointInputTimer: null,
    offerCheckPromise: null,
    unavailableOffer: null,
    lastDecreaseNotice: null,
    hasLoadedModels: false,
    loading: false,
};

function settings() {
    return state.getSettings?.() || {};
}

function save() {
    state.saveSettings?.();
}

function number(value, fallback = null) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function firstNumber(...values) {
    for (const value of values) {
        const parsed = number(value);
        if (parsed !== null) return parsed;
    }
    return null;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function percentage(oldValue, newValue) {
    if (!Number.isFinite(oldValue) || oldValue === 0) return null;
    return ((newValue - oldValue) / Math.abs(oldValue)) * 100;
}

function formatUsd(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const amount = Number(value);
    if (amount === 0) return t`Free`;
    const decimals = amount < 0.01 ? Number(amount.toPrecision(2)).toString() : amount.toFixed(2);
    return `$${decimals}/M`;
}

function formatCents(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const amount = Number(value);
    if (amount === 0) return t`Free`;
    if (amount >= 1) return `$${amount.toFixed(2)}`;
    const cents = amount * 100;
    const decimals = cents < 0.01 ? Number(cents.toPrecision(2)).toString() : cents.toFixed(2);
    return `${decimals}¢`;
}

function formatReputation(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return Number(Number(value).toFixed(2)).toString();
}

function estimateTokens() {
    const current = settings();
    const contextTokens = number(current.openai_max_context);
    const outputTokens = number(current.openai_max_tokens);
    if (contextTokens === null || outputTokens === null) return null;
    return {
        inputTokens: Math.max(0, contextTokens - outputTokens),
        outputTokens: Math.max(0, outputTokens),
    };
}

function estimate(offer) {
    const input = number(offer.inputUsdPerMillion);
    const output = number(offer.outputUsdPerMillion);
    const tokens = estimateTokens();
    if (input === null || output === null || !tokens) return null;
    return (tokens.inputTokens / 1_000_000 * input) + (tokens.outputTokens / 1_000_000 * output);
}

function valueForSort(item, key) {
    const value = item[key];
    if (typeof value === 'string') return value.toLocaleLowerCase();
    return value;
}

function sortItems(items, sort) {
    return [...items].sort((a, b) => {
        const left = valueForSort(a, sort.key);
        const right = valueForSort(b, sort.key);
        const leftMissing = left === null || left === undefined || (typeof left === 'number' && !Number.isFinite(left));
        const rightMissing = right === null || right === undefined || (typeof right === 'number' && !Number.isFinite(right));
        if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
        if (leftMissing && rightMissing) return String(a.modelName || a.providerName || '').localeCompare(String(b.modelName || b.providerName || ''));
        if (left < right) return -1 * sort.direction;
        if (left > right) return 1 * sort.direction;
        return String(a.modelName || a.providerName || '').localeCompare(String(b.modelName || b.providerName || ''));
    });
}

function minFinite(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? Math.min(...finite) : null;
}

function sortHeader(label, key, sort, pane) {
    const active = sort.key === key;
    const arrow = active ? (sort.direction === 1 ? ' ↑' : ' ↓') : '';
    return `<button type="button" class="antseed-sort-header" data-antseed-sort="${key}" data-antseed-pane="${pane}">${label}<span class="antseed-sort-arrow">${arrow}</span></button>`;
}

function priceValue(source, names) {
    const values = names.map(name => source?.[name]);
    const direct = firstNumber(...values);
    if (direct !== null) return direct;
    return null;
}

function normalizePrice(source, kind) {
    const millionNames = kind === 'input'
        ? ['inputUsdPerMillion', 'input_usd_per_million', 'inputPriceUsdPerMillion', 'promptUsdPerMillion']
        : kind === 'output'
            ? ['outputUsdPerMillion', 'output_usd_per_million', 'outputPriceUsdPerMillion', 'completionUsdPerMillion']
            : ['cachedInputUsdPerMillion', 'cached_input_usd_per_million', 'cacheUsdPerMillion', 'cachedPriceUsdPerMillion'];
    const direct = priceValue(source, millionNames);
    if (direct !== null) return direct;
    const pricing = source?.pricing || source?.price || {};
    const pricingValue = priceValue(pricing, kind === 'input' ? ['inputUsdPerMillion', 'input_usd_per_million', 'input'] : kind === 'output' ? ['outputUsdPerMillion', 'output_usd_per_million', 'output', 'completion'] : ['cachedInputUsdPerMillion', 'cached_input_usd_per_million', 'cached_input', 'cache_read']);
    if (pricingValue !== null) {
        // OpenAI-compatible pricing commonly uses dollars per token.
        return pricingValue > 0 && pricingValue < 0.01 ? pricingValue * 1_000_000 : pricingValue;
    }
    return null;
}

function peerServices(peer) {
    const services = peer?.services || peer?.offers;
    if (Array.isArray(services) && services.length) return services.map(service => ({ peer, service: service && typeof service === 'object' ? service : {} }));
    if (services && typeof services === 'object') return Object.entries(services).map(([, service]) => ({ peer, service: service && typeof service === 'object' ? service : {} }));
    return [{ peer, service: peer }];
}

function validText(value) {
    const text = String(value ?? '').trim();
    return text || null;
}

function validateOffer(offer) {
    const valid = offer.modelId && offer.peerId && offer.serviceId && offer.modelName && offer.providerName;
    if (!valid) {
        console.warn('[AntSeed] Ignoring malformed offer:', offer);
    }
    return Boolean(valid);
}

/** Normalize AntSeed's hierarchical model/peer response without mixing identities. */
export function normalizeAntSeedModels(payload) {
    const rawModels = Array.isArray(payload) ? payload : payload?.data || payload?.models || [];
    const offers = [];
    const seen = new Set();
    for (const model of rawModels) {
        if (!model || typeof model !== 'object') continue;
        const modelId = validText(model.id);
        if (!modelId) continue;
        const peers = Array.isArray(model.peers) ? model.peers : Array.isArray(model.providers) ? model.providers : [];
        for (const peer of peers) {
            if (!peer || typeof peer !== 'object') continue;
            for (const { peer: peerRecord, service } of peerServices(peer)) {
                const peerId = validText(peerRecord.peerId || peerRecord.peer_id);
                const serviceId = validText(service.serviceId || service.service_id || peerRecord.serviceId || peerRecord.service_id) || modelId;
                const providerName = validText(peerRecord.displayName) || peerId;
                const source = service === peerRecord ? peerRecord : { ...peerRecord, ...service };
                const peerCapabilities = peerRecord.capabilities;
                const offer = {
                    modelId,
                    modelName: validText(model.name) || modelId,
                    aliases: Array.isArray(model.aliases) ? model.aliases : [],
                    peerId,
                    providerName,
                    serviceId,
                    inputUsdPerMillion: normalizePrice(source, 'input'),
                    outputUsdPerMillion: normalizePrice(source, 'output'),
                    cachedInputUsdPerMillion: normalizePrice(source, 'cached'),
                    reputationScore: firstNumber(peerRecord.reputationScore, peerRecord.reputation_score),
                    effectiveReputationScore: firstNumber(peerRecord.effectiveReputationScore, peerRecord.effective_reputation_score),
                    onChainTrustScore: firstNumber(peerRecord.onChainTrustScore, peerRecord.on_chain_trust_score),
                    onChainReputationScore: firstNumber(peerRecord.onChainReputationScore, peerRecord.on_chain_reputation_score),
                    protocol: peerRecord.protocol,
                    protocols: peerRecord.protocols,
                    categories: peerRecord.categories,
                    peerCapabilities,
                    contextLength: firstNumber(peerCapabilities?.contextWindow, model.context_length),
                    maxOutputTokens: firstNumber(peerCapabilities?.maxOutputTokens, model.max_output_tokens),
                    modelCapabilities: model.capabilities,
                    architecture: model.architecture,
                };
                if (!validateOffer(offer)) continue;
                const offerKey = `${peerId}@${serviceId}`;
                if (seen.has(offerKey)) continue;
                seen.add(offerKey);
                offers.push({ ...offer, offerKey });
            }
        }
    }
    return offers.map(offer => ({ ...offer, estimatedCost: estimate(offer) }));
}

export function groupAntSeedOffers(offers) {
    const modelMap = new Map();
    const providerMap = new Map();
    for (const offer of offers) {
        if (!modelMap.has(offer.modelId)) {
            modelMap.set(offer.modelId, { modelId: offer.modelId, modelName: offer.modelName, aliases: offer.aliases, offers: [] });
        } else if (modelMap.get(offer.modelId).modelName !== offer.modelName) {
            console.warn('[AntSeed] Model name changed within modelId; keeping the outer model name from the first offer.', offer.modelId);
        }
        modelMap.get(offer.modelId).offers.push(offer);
        if (!providerMap.has(offer.peerId)) {
            providerMap.set(offer.peerId, { peerId: offer.peerId, providerName: offer.providerName, effectiveReputation: null, offers: [] });
        } else if (providerMap.get(offer.peerId).providerName !== offer.providerName) {
            console.warn('[AntSeed] Provider displayName changed within peerId; keeping the first peer displayName.', offer.peerId);
        }
        const provider = providerMap.get(offer.peerId);
        if (offer.effectiveReputationScore !== null && offer.effectiveReputationScore !== undefined) provider.effectiveReputation = offer.effectiveReputationScore;
        provider.offers.push(offer);
    }
    const models = [...modelMap.values()].map(model => ({
        ...model,
        offersCount: model.offers.length,
        bestEstimatedCost: minFinite(model.offers.map(offer => offer.estimatedCost)),
    }));
    const providers = [...providerMap.values()].map(provider => ({
        ...provider,
        modelsCount: new Set(provider.offers.map(offer => offer.modelId)).size,
        cheapestOffer: minFinite(provider.offers.map(offer => offer.estimatedCost)),
    }));
    return { models, providers };
}

function rebuildGroups() {
    const groups = groupAntSeedOffers(state.offers);
    state.models = groups.models;
    state.providers = groups.providers;
}

function acknowledgedPrices() {
    const current = settings().antseed_acknowledged_prices;
    return current && typeof current === 'object' ? current : {};
}

function setAcknowledged(offer) {
    const prices = acknowledgedPrices();
    prices[offer.offerKey] = Object.fromEntries(PRICE_FIELDS.map(field => [field, offer[field]]));
    settings().antseed_acknowledged_prices = prices;
    save();
}

function priceChange(offer) {
    const previous = acknowledgedPrices()[offer.offerKey];
    if (!previous) return { previous: null, increase: false, decrease: false };
    const increase = PRICE_FIELDS.some(field => Number.isFinite(offer[field]) && Number.isFinite(previous[field]) && offer[field] > previous[field]);
    const decrease = !increase && PRICE_FIELDS.some(field => Number.isFinite(offer[field]) && Number.isFinite(previous[field]) && offer[field] < previous[field]);
    return { previous, increase, decrease };
}

export function getSelectedAntSeedOffer(rawKey = String(settings().antseed_model || '').trim()) {
    const separator = rawKey.indexOf('@');
    if (separator < 1) return null;
    const peerId = rawKey.slice(0, separator);
    const serviceId = rawKey.slice(separator + 1);
    if (!serviceId) return null;
    return state.offers.find(offer => offer.peerId === peerId && offer.serviceId === serviceId) || null;
}

function syncSelection() {
    const offer = getSelectedAntSeedOffer();
    state.activeModelId = offer?.modelId || null;
    state.activePeerId = offer?.peerId || null;
    return offer;
}

function preserveActiveNavigation(modelId, peerId) {
    const configured = getSelectedAntSeedOffer();
    state.activeModelId = (state.models.some(model => model.modelId === modelId) ? modelId : null) || configured?.modelId || null;
    state.activePeerId = (state.providers.some(provider => provider.peerId === peerId) ? peerId : null) || configured?.peerId || null;
}

function updateSelectedSummary() {
    const element = document.getElementById('antseed_selected_offer');
    if (!element) return;
    const modelValue = String(settings().antseed_model || '').trim();
    const offer = getSelectedAntSeedOffer();
    const isLoading = !state.hasLoadedModels || state.loading || (typeof $ !== 'undefined' && $('.api_loading').is(':visible'));
    if (!modelValue) {
        element.innerHTML = `<span class="antseed-muted">${t`None`}</span>`;
    } else if (isLoading) {
        element.innerHTML = `<span class="antseed-muted">${t`Loading offer status…`}</span> <code>${escapeHtml(modelValue)}</code>`;
    } else if (!offer) {
        element.innerHTML = `<span class="antseed-warning">${t`Unknown or currently unavailable AntSeed offer`}</span> <code>${escapeHtml(modelValue)}</code>`;
    } else {
        element.innerHTML = `<span class="antseed-summary-title">${escapeHtml(offer.providerName)}</span><span class="antseed-summary-separator">·</span><span>${escapeHtml(offer.modelName)}</span><span class="antseed-summary-prices">${formatUsd(offer.inputUsdPerMillion)} in · ${formatUsd(offer.outputUsdPerMillion)} out · ${formatCents(offer.estimatedCost)} est.</span><span class="antseed-summary-reputation">Rep ${formatReputation(offer.effectiveReputationScore)}</span>`;
    }
}

function renderOfferRow(offer, { cheapest, showReputation = true, showRelative = true }) {
    const selected = String(settings().antseed_model || '').trim() === offer.offerKey ? ' antseed-selected' : '';
    const relative = showRelative && Number.isFinite(offer.estimatedCost) && Number.isFinite(cheapest) && cheapest > 0 ? offer.estimatedCost / cheapest : null;
    const relativeText = relative !== null && relative >= 2 ? `<small class="antseed-relative${relative >= 4 ? ' antseed-relative-strong' : ''}">${relative.toFixed(1)}${t`× cheapest`}</small>` : '';
    const label = showReputation
        ? `<span>${escapeHtml(offer.providerName)}</span><small class="antseed-id">${escapeHtml(offer.peerId)}</small>`
        : `<span>${escapeHtml(offer.modelName)}</span><small class="antseed-id">${escapeHtml(offer.modelId)}</small>`;
    const check = selected ? `<span class="antseed-offer-check" aria-label="${t`Configured offer`}">✓</span>` : '';
    return `<tr class="antseed-offer-row${selected}" data-antseed-offer="${escapeHtml(offer.offerKey)}" tabindex="0" role="button"><td>${check}${label}</td><td>${formatUsd(offer.inputUsdPerMillion)}</td><td>${formatUsd(offer.outputUsdPerMillion)}</td><td>${formatUsd(offer.cachedInputUsdPerMillion)}</td>${showReputation ? `<td>${formatReputation(offer.effectiveReputationScore)}</td>` : ''}<td>${formatCents(offer.estimatedCost)} ${relativeText}</td></tr>`;
}

function renderModelBrowser() {
    const filtered = state.models.filter(model => `${model.modelName} ${model.modelId} ${(model.aliases || []).join(' ')}`.toLocaleLowerCase().includes(state.query));
    const models = sortItems(filtered, state.modelMasterSort);
    const selectedModel = models.find(model => model.modelId === state.activeModelId) || models[0];
    state.activeModelId = selectedModel?.modelId || null;
    const masterRows = models.map(model => `<tr class="antseed-master-row${model.modelId === state.activeModelId ? ' antseed-active' : ''}" data-antseed-model="${escapeHtml(model.modelId)}" tabindex="0" role="button"><td><span>${escapeHtml(model.modelName)}</span><small class="antseed-id">${escapeHtml(model.modelId)}</small></td><td>${model.offersCount}</td><td>${formatCents(model.bestEstimatedCost)}</td></tr>`).join('');
    const offers = selectedModel ? sortItems(selectedModel.offers.map(offer => ({ ...offer, estimatedCost: estimate(offer) })), state.modelDetailSort) : [];
    const cheapest = minFinite(offers.map(offer => offer.estimatedCost));
    const detailRows = offers.map(offer => renderOfferRow(offer, { cheapest })).join('');
    return `<div class="antseed-browser-grid"><div class="antseed-browser-pane antseed-master-pane"><div class="antseed-pane-title">${t`Models`}</div><table class="antseed-browser-table"><thead><tr><th>${sortHeader(t`Model`, 'modelName', state.modelMasterSort, 'master')}</th><th>${sortHeader(t`Offers`, 'offersCount', state.modelMasterSort, 'master')}</th><th>${sortHeader(t`Best Cost`, 'bestEstimatedCost', state.modelMasterSort, 'master')}</th></tr></thead><tbody>${masterRows || `<tr><td colspan="3" class="antseed-empty">${state.query ? t`No results matching “${state.query}”.` : t`No AntSeed models found.`}</td></tr>`}</tbody></table></div><div class="antseed-browser-pane antseed-detail-pane"><div class="antseed-pane-title">${selectedModel ? t`Offers for ${selectedModel.modelName}` : t`Offers`}</div><table class="antseed-browser-table"><thead><tr><th>${sortHeader(t`Provider`, 'providerName', state.modelDetailSort, 'detail')}</th><th>${sortHeader(t`Input`, 'inputUsdPerMillion', state.modelDetailSort, 'detail')}</th><th>${sortHeader(t`Output`, 'outputUsdPerMillion', state.modelDetailSort, 'detail')}</th><th>${sortHeader(t`Cached`, 'cachedInputUsdPerMillion', state.modelDetailSort, 'detail')}</th><th>${sortHeader(t`Eff. Rep`, 'effectiveReputationScore', state.modelDetailSort, 'detail')}</th><th>${sortHeader(t`Est.`, 'estimatedCost', state.modelDetailSort, 'detail')}</th></tr></thead><tbody>${detailRows || `<tr><td colspan="6" class="antseed-empty">${selectedModel ? t`No providers currently offer this model.` : t`Select a model to compare offers.`}</td></tr>`}</tbody></table></div></div>`;
}

function renderProviderBrowser() {
    const filtered = state.providers.filter(provider => `${provider.providerName} ${provider.peerId}`.toLocaleLowerCase().includes(state.query));
    const providers = sortItems(filtered, state.providerMasterSort);
    const selectedProvider = providers.find(provider => provider.peerId === state.activePeerId) || providers[0];
    state.activePeerId = selectedProvider?.peerId || null;
    const masterRows = providers.map(provider => `<tr class="antseed-master-row${provider.peerId === state.activePeerId ? ' antseed-active' : ''}" data-antseed-provider="${escapeHtml(provider.peerId)}" tabindex="0" role="button"><td><span>${escapeHtml(provider.providerName)}</span><small class="antseed-id">${escapeHtml(provider.peerId)}</small></td><td>${provider.modelsCount}</td><td>${formatReputation(provider.effectiveReputation)}</td></tr>`).join('');
    const offers = selectedProvider ? sortItems(selectedProvider.offers.map(offer => ({ ...offer, estimatedCost: estimate(offer) })), state.providerDetailSort) : [];
    const detailRows = offers.map(offer => renderOfferRow(offer, { showReputation: false, showRelative: false })).join('');
    return `<div class="antseed-browser-grid"><div class="antseed-browser-pane antseed-master-pane"><div class="antseed-pane-title">${t`Providers`}</div><table class="antseed-browser-table"><thead><tr><th>${sortHeader(t`Provider`, 'providerName', state.providerMasterSort, 'master')}</th><th>${sortHeader(t`Models`, 'modelsCount', state.providerMasterSort, 'master')}</th><th>${sortHeader(t`Eff. Rep`, 'effectiveReputation', state.providerMasterSort, 'master')}</th></tr></thead><tbody>${masterRows || `<tr><td colspan="3" class="antseed-empty">${state.query ? t`No results matching “${state.query}”.` : t`No AntSeed providers found.`}</td></tr>`}</tbody></table></div><div class="antseed-browser-pane antseed-detail-pane"><div class="antseed-pane-title">${selectedProvider ? t`Models from ${selectedProvider.providerName}` : t`Models`}</div><table class="antseed-browser-table"><thead><tr><th>${sortHeader(t`Model`, 'modelName', state.providerDetailSort, 'detail')}</th><th>${sortHeader(t`Input`, 'inputUsdPerMillion', state.providerDetailSort, 'detail')}</th><th>${sortHeader(t`Output`, 'outputUsdPerMillion', state.providerDetailSort, 'detail')}</th><th>${sortHeader(t`Cached`, 'cachedInputUsdPerMillion', state.providerDetailSort, 'detail')}</th><th>${sortHeader(t`Est.`, 'estimatedCost', state.providerDetailSort, 'detail')}</th></tr></thead><tbody>${detailRows || `<tr><td colspan="5" class="antseed-empty">${selectedProvider ? t`No models found for this provider.` : t`Select a provider to compare models.`}</td></tr>`}</tbody></table></div></div>`;
}

function renderBrowser() {
    const browser = document.getElementById('antseed_browser');
    if (!browser) return;
    state.offers = state.offers.map(offer => ({ ...offer, estimatedCost: estimate(offer) }));
    rebuildGroups();
    const input = document.getElementById('antseed_search');
    const clearSearch = document.getElementById('antseed_clear_search');
    const mode = document.getElementById('antseed_browser_mode');
    const table = document.getElementById('antseed_browser_table');
    if (input && input.value !== state.query) input.value = state.query;
    if (clearSearch) clearSearch.classList.toggle('displayNone', !state.query);
    if (mode) mode.innerHTML = `<button type="button" class="menu_button${state.mode === 'models' ? ' antseed-tab-active' : ''}" data-antseed-mode="models">${t`Models`}</button><button type="button" class="menu_button${state.mode === 'providers' ? ' antseed-tab-active' : ''}" data-antseed-mode="providers">${t`Providers`}</button>`;
    if (table) table.innerHTML = state.loading && !state.offers.length ? `<div class="antseed-loading">${t`Loading offers…`}</div>` : state.mode === 'models' ? renderModelBrowser() : renderProviderBrowser();
    updateSelectedSummary();
}

function browseAlternatives(modelId) {
    state.mode = 'models';
    state.query = '';
    state.activeModelId = modelId;
    state.modelDetailSort = { key: 'estimatedCost', direction: 1 };
    renderBrowser();
    document.getElementById('antseed_browser')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function showPriceChanged(offer, previous) {
    const prices = PRICE_FIELDS.map(field => {
        const label = field === 'inputUsdPerMillion' ? t`Input` : field === 'outputUsdPerMillion' ? t`Output` : t`Cached`;
        const oldValue = previous[field];
        const newValue = offer[field];
        const change = percentage(oldValue, newValue);
        return `<tr><td>${label}</td><td>${formatUsd(oldValue)}</td><td>${formatUsd(newValue)}</td><td>${change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(0)}%`}</td></tr>`;
    }).join('');
    const oldEstimated = estimate(previous);
    const currentEstimated = estimate(offer);
    const estimatedChange = percentage(oldEstimated, currentEstimated);
    const html = `<p>${t`The selected AntSeed provider changed its pricing.`}</p><p><b>${escapeHtml(offer.modelName)}</b><br>${escapeHtml(offer.providerName)}</p><table class="antseed-price-table"><thead><tr><th></th><th>${t`Previous`}</th><th>${t`Current`}</th><th>${t`Change`}</th></tr></thead><tbody>${prices}<tr><td>${t`Estimated cost`}</td><td>${formatCents(oldEstimated)}</td><td>${formatCents(currentEstimated)}</td><td>${estimatedChange === null ? '—' : `+${estimatedChange.toFixed(0)}%`}</td></tr></tbody></table>`;
    const result = await Popup.show.text(t`AntSeed Price Changed`, DOMPurify.sanitize(html), {
        okButton: false,
        cancelButton: false,
        customButtons: [
            { text: t`Browse Alternatives`, result: POPUP_RESULT.CUSTOM1 },
            { text: t`Accept New Price`, result: POPUP_RESULT.CUSTOM2, classes: ['menu_button'] },
        ],
    });
    state.pendingPriceDialog = null;
    if (result === POPUP_RESULT.CUSTOM2) {
        setAcknowledged(offer);
        return true;
    }
    if (result === POPUP_RESULT.CUSTOM1) browseAlternatives(offer.modelId);
    return false;
}

async function showUnavailable(offerKey, modelId, modelName, providerName) {
    if (state.unavailableOffer === offerKey) return;
    state.unavailableOffer = offerKey;
    const result = await Popup.show.text(t`AntSeed Offer Unavailable`, escapeHtml(t`${providerName || 'The selected provider'} no longer advertises ${modelName || 'the selected model'}.`), {
        okButton: false,
        cancelButton: false,
        customButtons: [
            { text: t`Browse Providers`, result: POPUP_RESULT.CUSTOM1 },
            { text: t`Close`, result: POPUP_RESULT.CANCELLED },
        ],
    });
    if (result === POPUP_RESULT.CUSTOM1) browseAlternatives(modelId || modelName);
}

async function inspectSelectedOffer({ allowPrompt = true, modelKey = null } = {}) {
    const selected = String(modelKey ?? settings().antseed_model ?? '').trim();
    if (!selected) return true;
    const offer = getSelectedAntSeedOffer(selected);
    if (!offer) return true;
    const change = priceChange(offer);
    if (change.decrease) {
        const noticeKey = `${offer.offerKey}:${JSON.stringify(offer)}`;
        if (state.lastDecreaseNotice !== noticeKey) {
            const cheaper = percentage(estimate(change.previous), estimate(offer));
            if (cheaper !== null) window.toastr?.info(t`${offer.providerName} — ${offer.modelName} is now ${Math.abs(cheaper).toFixed(0)}% cheaper.`);
            state.lastDecreaseNotice = noticeKey;
        }
        setAcknowledged(offer);
        return true;
    }
    if (change.increase) {
        if (!allowPrompt) return false;
        const dialogKey = `${offer.offerKey}:${JSON.stringify(change.previous)}:${JSON.stringify(offer)}`;
        if (state.pendingPriceDialog !== dialogKey) {
            state.pendingPriceDialog = dialogKey;
            return showPriceChanged(offer, change.previous);
        }
        return false;
    }
    if (!change.previous) setAcknowledged(offer);
    return true;
}

export function syncAntSeedContext(offer = getSelectedAntSeedOffer()) {
    if (!offer) return;
    const current = settings();
    const $ctx = typeof $ !== 'undefined' ? $('#openai_max_context') : null;
    const $tok = typeof $ !== 'undefined' ? $('#openai_max_tokens') : null;
    if (Number.isFinite(offer.contextLength) && offer.contextLength > 0) {
        const maxContext = current.max_context_unlocked ? 2000000 : offer.contextLength;
        $ctx?.attr('max', maxContext);
        if (typeof $ !== 'undefined') {
            $('#openai_max_context_counter').attr('max', maxContext);
        }
        if ($ctx && $ctx.length) {
            current.openai_max_context = Number.isFinite(Number(current.openai_max_context))
                ? Math.min(Number($ctx.attr('max')), Number(current.openai_max_context))
                : maxContext;
            $ctx.val(current.openai_max_context).trigger('input');
        }
    }
    if (Number.isFinite(offer.maxOutputTokens) && offer.maxOutputTokens > 0) {
        $tok?.attr('max', offer.maxOutputTokens);
        if ($tok && $tok.length && Number.isFinite(Number(current.openai_max_tokens))) {
            current.openai_max_tokens = Math.min(Number($tok.attr('max')), Number(current.openai_max_tokens));
            $tok.val(current.openai_max_tokens).trigger('input');
        }
    }
}

function selectOffer(offerKey) {
    const offer = state.offers.find(item => item.offerKey === offerKey);
    if (!offer) return;
    settings().antseed_model = offer.offerKey;
    state.activeModelId = offer.modelId;
    state.activePeerId = offer.peerId;
    const input = document.getElementById('antseed_model');
    if (input) input.value = offer.offerKey;
    state.unavailableOffer = null;
    setAcknowledged(offer);
    syncAntSeedContext(offer);
    renderBrowser();
    save();
    if (typeof $ !== 'undefined') {
        $('#antseed_model').trigger('change');
    }
}

export function updateAntSeedModels(payload) {
    const previousSelected = getSelectedAntSeedOffer();
    const previousActiveModelId = state.activeModelId;
    const previousActivePeerId = state.activePeerId;
    state.offers = normalizeAntSeedModels(payload);
    state.hasLoadedModels = true;
    state.loading = false;
    rebuildGroups();
    preserveActiveNavigation(previousActiveModelId, previousActivePeerId);
    renderBrowser();
    const selected = String(settings().antseed_model || '').trim();
    const currentSelected = getSelectedAntSeedOffer();
    if (selected && !currentSelected) {
        if (previousSelected && previousSelected.offerKey === selected) {
            const separator = selected.indexOf('@');
            const peerId = separator > 0 ? selected.slice(0, separator) : null;
            const serviceId = separator > 0 ? selected.slice(separator + 1) : null;
            void showUnavailable(
                selected,
                previousSelected?.modelId || serviceId,
                previousSelected?.modelName || serviceId,
                previousSelected?.providerName || peerId,
            );
        }
    } else if (currentSelected) {
        syncAntSeedContext(currentSelected);
        state.offerCheckPromise = Promise.resolve(inspectSelectedOffer({ allowPrompt: false }));
    }
    return state.offers;
}

async function fetchModels() {
    if (!state.refresh) return;
    state.loading = true;
    renderBrowser();
    try {
        await state.refresh();
    } finally {
        state.loading = false;
        renderBrowser();
    }
}

export async function ensureAntSeedOfferSafe(modelKey = null) {
    await fetchModels();
    if (state.offerCheckPromise) {
        await state.offerCheckPromise;
        state.offerCheckPromise = null;
    }
    const key = String(modelKey ?? settings().antseed_model ?? '').trim();
    if (!key) {
        window.toastr?.error(t`No AntSeed offer selected. Choose an available offer before sending.`);
        return { safe: false, reason: 'unavailable', message: t`No AntSeed offer selected.` };
    }
    if (state.hasLoadedModels && !getSelectedAntSeedOffer(key)) {
        window.toastr?.error(t`The selected AntSeed offer is unknown or unavailable. Choose an available offer before sending.`);
        return { safe: false, reason: 'unavailable', message: t`The selected AntSeed offer is unknown or unavailable.` };
    }
    const safe = await inspectSelectedOffer({ allowPrompt: true, modelKey: key });
    if (!safe) {
        return { safe: false, reason: 'unacknowledged', message: t`AntSeed price change was not acknowledged.` };
    }
    return { safe: true };
}

export function refreshAntSeedUI() {
    const current = settings();
    state.loading = !state.hasLoadedModels && !state.offers.length;
    const endpoint = document.getElementById('antseed_endpoint');
    const model = document.getElementById('antseed_model');
    if (endpoint && endpoint.value !== current.antseed_endpoint) endpoint.value = current.antseed_endpoint || ANTSEED_DEFAULT_ENDPOINT;
    if (model && model.value !== current.antseed_model) model.value = current.antseed_model || '';
    state.offers = state.offers.map(offer => ({ ...offer, estimatedCost: estimate(offer) }));
    const configured = getSelectedAntSeedOffer();
    if (configured) {
        state.activeModelId = configured.modelId;
        state.activePeerId = configured.peerId;
        syncAntSeedContext(configured);
    }
    rebuildGroups();
    renderBrowser();
}

export function initAntSeed({ getSettings, saveSettings, refresh }) {
    state.getSettings = getSettings;
    state.saveSettings = saveSettings;
    state.refresh = refresh;
    $('#openai_max_context, #openai_max_tokens').on('input change', renderBrowser);
    $('#antseed_endpoint').on('input change', function (event, data) {
        const nextValue = String(this.value).trim() || ANTSEED_DEFAULT_ENDPOINT;
        const changed = settings().antseed_endpoint !== nextValue;
        settings().antseed_endpoint = nextValue;
        save();
        if (!changed) return;
        window.clearTimeout(state.endpointInputTimer);
        if (event.type === 'change' || data?.source === 'preset') {
            void refresh?.();
        } else {
            state.endpointInputTimer = window.setTimeout(() => void refresh?.(), 500);
        }
    });
    $('#antseed_model').on('input', function () {
        settings().antseed_model = String(this.value).trim();
        state.unavailableOffer = null;
        save();
        syncSelection();
        syncAntSeedContext();
        window.clearTimeout(state.modelInputTimer);
        state.modelInputTimer = window.setTimeout(() => {
            renderBrowser();
        }, 250);
    });
    $('#antseed_refresh').on('click', () => void refresh?.());
    $('#antseed_search').on('input', function () {
        state.query = String(this.value).trim().toLocaleLowerCase();
        renderBrowser();
    });
    $('#antseed_clear_search').on('click', function () {
        state.query = '';
        renderBrowser();
        $('#antseed_search').trigger('focus');
    });
    $('#antseed_browser_mode').on('click', '[data-antseed-mode]', function () {
        state.mode = this.dataset.antseedMode;
        syncSelection();
        renderBrowser();
    });
    $('#antseed_browser_table').on('click', '[data-antseed-sort]', function (event) {
        event.stopPropagation();
        const key = this.dataset.antseedSort;
        const pane = this.dataset.antseedPane;
        const sort = state.mode === 'models'
            ? (pane === 'detail' ? state.modelDetailSort : state.modelMasterSort)
            : (pane === 'detail' ? state.providerDetailSort : state.providerMasterSort);
        sort.direction = sort.key === key ? sort.direction * -1 : 1;
        sort.key = key;
        renderBrowser();
    });
    $('#antseed_browser_table').on('click', '[data-antseed-offer]', function (event) {
        event.stopPropagation();
        selectOffer(this.dataset.antseedOffer);
    });
    $('#antseed_browser_table').on('click', '[data-antseed-model]', function () {
        state.activeModelId = this.dataset.antseedModel;
        renderBrowser();
    });
    $('#antseed_browser_table').on('click', '[data-antseed-provider]', function () {
        state.activePeerId = this.dataset.antseedProvider;
        renderBrowser();
    });
    $('#antseed_browser_table').on('keydown', '[data-antseed-offer], [data-antseed-model], [data-antseed-provider]', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        $(this).trigger('click');
    });
    state.refreshTimer = window.setInterval(() => {
        if (settings().chat_completion_source === 'antseed') void refresh?.();
    }, 60_000);
    refreshAntSeedUI();
}
