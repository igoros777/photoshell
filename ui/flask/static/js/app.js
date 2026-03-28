/* PhotoShell UI - frontend logic */

document.addEventListener("DOMContentLoaded", function() {
    var form           = document.getElementById("workflow-form");
    var photoDirInput  = document.getElementById("photo_dir");
    var btnRun         = document.getElementById("btn-run");
    var btnCancel      = document.getElementById("btn-cancel");
    var btnBrowse      = document.getElementById("btn-browse");
    var btnValidate    = document.getElementById("btn-validate");
    var btnValidateWf  = document.getElementById("btn-validate-workflow");
    var validationResult = document.getElementById("validation-result");
    var advisoryPanel  = document.getElementById("advisory-panel");
    var folderStatus   = document.getElementById("folder-status");
    var folderMetaStats = document.getElementById("folder-meta-stats");
    var logPanel       = document.getElementById("log-panel");
    var progressBar    = document.getElementById("pipeline-progress");
    var stepsContainer = document.getElementById("pipeline-steps");
    var inspectorPanel = document.getElementById("inspector-panel");
    var inspectorTitle = document.getElementById("inspector-title");
    var inspectorContent = document.getElementById("inspector-content");

    // Folder browser modal elements
    var browserModal     = new bootstrap.Modal(document.getElementById("folderBrowserModal"));
    var browserPathInput = document.getElementById("browser-path-input");
    var browserGoBtn     = document.getElementById("browser-go-btn");
    var browserList      = document.getElementById("browser-list");
    var browserSelectBtn = document.getElementById("browser-select-btn");

    // Docs modal elements
    var docsModalEl  = document.getElementById("docsModal");
    var docsModal    = new bootstrap.Modal(docsModalEl);
    var docsTitle    = document.getElementById("docs-modal-title");
    var docsLoading  = document.getElementById("docs-loading");
    var docsContent  = document.getElementById("docs-content");

    // Photo thumbnail grid elements
    var photoThumbsContainer = document.getElementById("photo-thumbs");
    var photoThumbsHeader = document.getElementById("photo-thumbs-header");
    var photoThumbsGrid = document.getElementById("photo-thumbs-grid");
    var photoThumbsFooter = document.getElementById("photo-thumbs-footer");

    var currentJobId = null;
    var pollTimer    = null;
    var folderValid  = false;
    var validateTimer = null;
    var pendingMermaidDivs = null; // mermaid divs waiting for modal shown event
    var orderOverride = false; // user acknowledged ordering concerns

    // Thumbnail grid state
    var currentThumbPath = "";
    var currentThumbPage = 1;
    var thumbFiles = [];   // all loaded file objects for preview modal
    var thumbObserver = null;

    // Streaming log state
    var logOffset = 0;
    var logLineCount = 0;
    var logAutoScroll = true;

    // Map view state
    var mapInstance = null;
    var mapMarkers = null;
    var mapInitialized = false;
    var currentMapPath = "";
    var cameraColorMap = {};
    var cameraColorIndex = 0;

    // Content view state
    var activeContentView = "thumbs";
    var contentViewTabs = document.getElementById("content-view-tabs");

    // Multi-folder project mode state
    var detectedSubfolders = [];

    // Blur view state
    var blurScenes = [];
    var currentBlurScene = 0;
    var blurSliderDragging = false;

    // ---- Notification sounds (Web Audio API — no external files) ----

    function playSuccessSound() {
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Ascending two-note chime: C5 → E5
            [523.25, 659.25].forEach(function(freq, i) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(ctx.currentTime + i * 0.15);
                osc.stop(ctx.currentTime + i * 0.15 + 0.4);
            });
            setTimeout(function() { ctx.close(); }, 1000);
        } catch(e) { /* Audio not available */ }
    }

    function playErrorSound() {
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Descending two-note: E4 → C4
            [329.63, 261.63].forEach(function(freq, i) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = "triangle";
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.18, ctx.currentTime + i * 0.2);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.2 + 0.35);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(ctx.currentTime + i * 0.2);
                osc.stop(ctx.currentTime + i * 0.2 + 0.35);
            });
            setTimeout(function() { ctx.close(); }, 1000);
        } catch(e) { /* Audio not available */ }
    }

    // ---- Initialize Bootstrap popovers for info tooltips ----

    document.querySelectorAll(".step-tooltip").forEach(function(el) {
        new bootstrap.Popover(el, {
            container: "body",
            placement: "top",
            html: false
        });
    });

    // ---- Documentation modal links ----

    document.querySelectorAll(".step-docs-link").forEach(function(el) {
        el.addEventListener("click", function(e) {
            e.stopPropagation();
            var docKey = el.dataset.doc;
            openDocsModal(docKey);
        });
    });

    function renderPendingMermaid() {
        if (!pendingMermaidDivs || pendingMermaidDivs.length === 0) return;
        var divs = pendingMermaidDivs;
        pendingMermaidDivs = null;
        mermaid.run({ nodes: divs }).catch(function(e) {
            console.warn("Mermaid rendering error:", e);
        });
    }

    // When the modal is fully visible (animation done), render mermaid
    docsModalEl.addEventListener("shown.bs.modal", function() {
        renderPendingMermaid();
    });

    function openDocsModal(docKey) {
        pendingMermaidDivs = null;
        docsLoading.style.display = "block";
        docsContent.innerHTML = "";
        docsContent.style.display = "none";
        docsTitle.innerHTML = '';
        var loadIcon = document.createElement('i');
        loadIcon.className = 'bi bi-book';
        docsTitle.appendChild(loadIcon);
        docsTitle.appendChild(document.createTextNode(' Loading...'));
        docsModal.show();

        fetch("/api/docs/" + encodeURIComponent(docKey))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    docsLoading.style.display = "none";
                    docsContent.style.display = "block";
                    docsContent.innerHTML = '';
                    var errDiv = document.createElement('div');
                    errDiv.className = 'text-danger';
                    errDiv.textContent = 'Error: ' + data.error;
                    docsContent.appendChild(errDiv);
                    return;
                }

                docsTitle.innerHTML = '';
                var icon = document.createElement('i');
                icon.className = 'bi bi-book';
                docsTitle.appendChild(icon);
                docsTitle.appendChild(document.createTextNode(' ' + data.filename));

                // Let marked parse everything normally (mermaid blocks become
                // <pre><code class="language-mermaid">...</code></pre>)
                var html = marked.parse(data.content);
                docsLoading.style.display = "none";
                docsContent.innerHTML = html;
                docsContent.style.display = "block";

                // Find code blocks that marked tagged as language-mermaid,
                // replace the <pre> with a <div class="mermaid"> containing
                // the decoded text, then let mermaid render them.
                var codeBlocks = docsContent.querySelectorAll('code.language-mermaid');
                var mermaidDivs = [];
                for (var i = 0; i < codeBlocks.length; i++) {
                    var pre = codeBlocks[i].closest("pre");
                    if (!pre) continue;
                    // textContent automatically decodes &lt; &gt; &amp; etc.
                    var raw = codeBlocks[i].textContent;
                    var div = document.createElement("div");
                    div.className = "mermaid";
                    div.textContent = raw;
                    pre.parentNode.replaceChild(div, pre);
                    mermaidDivs.push(div);
                }

                if (mermaidDivs.length > 0) {
                    // Check if modal is already fully visible
                    if (docsModalEl.classList.contains("show")) {
                        // Modal already shown, render immediately
                        mermaid.run({ nodes: mermaidDivs }).catch(function(e) {
                            console.warn("Mermaid rendering error:", e);
                        });
                    } else {
                        // Modal still animating, defer until shown
                        pendingMermaidDivs = mermaidDivs;
                    }
                }

                // Wire up internal doc links (open another doc in the same modal)
                docsContent.querySelectorAll(".docs-internal-link").forEach(function(link) {
                    link.addEventListener("click", function(ev) {
                        ev.preventDefault();
                        var targetDoc = link.getAttribute("data-doc");
                        if (targetDoc) openDocsModal(targetDoc);
                    });
                });
            })
            .catch(function(err) {
                docsLoading.style.display = "none";
                docsContent.style.display = "block";
                docsContent.innerHTML = '';
                var errDiv = document.createElement('div');
                errDiv.className = 'text-danger';
                errDiv.textContent = 'Failed to load documentation: ' + err;
                docsContent.appendChild(errDiv);
            });
    }

    // ---- Step sequencing and order validation ----

    var STEP_RECOMMENDED_ORDER = {
        "enable_sync_exif":        1,
        "enable_gps_gap_fill":     2,
        "enable_gps_set_loc":      3,
        "enable_extract_summary":  4,
        "enable_annotate_desc":    5,
        "enable_annotate_kw":      6,
        "enable_annotate_hl":      7,
        "enable_geo_rename":       8,
        "enable_gopro":            9,
        "enable_blur":            10,
        "enable_metadata_replace":   11,
        "enable_metadata_copyright": 12,
        "enable_metadata_consistency": 13,
        "enable_catalog_update":  14,
        "enable_contact_sheet":   15,
        "enable_scrub":           16
    };

    var STEP_LABELS = {
        "enable_sync_exif":       "Sync EXIF & Rename",
        "enable_gps_gap_fill":    "GPS Gap Fill",
        "enable_gps_set_loc":     "Set GPS Location",
        "enable_extract_summary": "Extract Photo Summary",
        "enable_annotate_desc":   "Annotate - Description",
        "enable_annotate_kw":     "Annotate - Keywords",
        "enable_annotate_hl":     "Annotate - Headline",
        "enable_blur":            "Detect Blurry Photos",
        "enable_geo_rename":      "Geo Rename Photos",
        "enable_gopro":           "GoPro Geo Rename",
        "enable_metadata_replace":   "Metadata Replace",
        "enable_metadata_copyright": "Copyright / Creator",
        "enable_metadata_consistency": "Consistency Audit",
        "enable_catalog_update":  "Update Catalog",
        "enable_contact_sheet":   "Contact Sheet",
        "enable_scrub":           "Scrub Metadata"
    };

    // Map step keys to config panel IDs
    var STEP_CONFIG_MAP = {
        "enable_sync_exif":       "config-sync",
        "enable_gps_gap_fill":    "config-gps",
        "enable_gps_set_loc":     "config-gps-set",
        "enable_extract_summary": "config-summary",
        "enable_annotate_desc":   "config-desc",
        "enable_annotate_kw":     "config-kw",
        "enable_annotate_hl":     "config-hl",
        "enable_blur":            "config-blur",
        "enable_geo_rename":      "config-geo",
        "enable_gopro":           "config-gopro",
        "enable_metadata_replace":   "config-mreplace",
        "enable_metadata_copyright": "config-mcopy",
        "enable_metadata_consistency": "config-mcon",
        "enable_catalog_update":  "config-catupd",
        "enable_contact_sheet":   "config-cs",
        "enable_scrub":           "config-scrub"
    };

    // Map sidebar data-step attribute to step keys
    var SIDEBAR_STEP_MAP = {
        "sync":    "enable_sync_exif",
        "gps":     "enable_gps_gap_fill",
        "gps_set": "enable_gps_set_loc",
        "summary": "enable_extract_summary",
        "desc":    "enable_annotate_desc",
        "kw":      "enable_annotate_kw",
        "hl":      "enable_annotate_hl",
        "blur":    "enable_blur",
        "geo":     "enable_geo_rename",
        "gopro":   "enable_gopro",
        "mreplace":"enable_metadata_replace",
        "mcopy":   "enable_metadata_copyright",
        "mcon":    "enable_metadata_consistency",
        "catupd":  "enable_catalog_update",
        "cs":      "enable_contact_sheet",
        "scrub":   "enable_scrub"
    };

    var ORDER_RULES = [
        {
            before: "enable_sync_exif",
            after: "enable_gps_gap_fill",
            reason: "Sync EXIF copies metadata from originals to exports. GPS Gap Fill needs the synced timestamps to find donor photos."
        },
        {
            before: "enable_sync_exif",
            after: "enable_extract_summary",
            reason: "Sync EXIF must run first so exports have the original camera/lens/exposure data that Extract Summary reads."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_extract_summary",
            reason: "Extract Summary uses GPS for reverse geocoding. Without GPS Gap Fill, photos missing coordinates will have no location in their summary."
        },
        {
            before: "enable_gps_set_loc",
            after: "enable_gps_gap_fill",
            reason: "Set GPS Location writes coordinates from a named location. GPS Gap Fill can then use those as donor photos for remaining gaps."
        },
        {
            before: "enable_gps_set_loc",
            after: "enable_extract_summary",
            reason: "Set GPS Location provides coordinates that Extract Summary uses for reverse geocoding."
        },
        {
            before: "enable_gps_set_loc",
            after: "enable_geo_rename",
            reason: "Set GPS Location provides coordinates that Geo Rename uses for location-based filenames."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_annotate_desc",
            reason: "Descriptions reference location context. GPS must be filled first so the LLM prompt includes accurate location data."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_annotate_kw",
            reason: "Keywords include location-based tags. GPS must be filled first so location keywords are accurate."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_geo_rename",
            reason: "Geo Rename builds filenames from GPS coordinates. Without GPS Gap Fill, photos missing coordinates will not get location-based names."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_gopro",
            reason: "GoPro Geo Rename builds clip names from GPS coordinates. GPS must be filled first."
        },
        {
            before: "enable_extract_summary",
            after: "enable_annotate_desc",
            reason: "Extract Summary writes technical metadata (camera, exposure, location) to comment fields. The description prompt reads these fields for context."
        },
        {
            before: "enable_extract_summary",
            after: "enable_annotate_kw",
            reason: "Extract Summary writes technical metadata that the keyword prompt uses for context (location name, camera model, etc.)."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_annotate_kw",
            reason: "The keyword prompt reads the generated description to produce more relevant keywords. Descriptions must be written first."
        },
        {
            before: "enable_gps_gap_fill",
            after: "enable_annotate_hl",
            reason: "Headlines reference location context. GPS must be filled first so the LLM prompt includes accurate location data."
        },
        {
            before: "enable_extract_summary",
            after: "enable_annotate_hl",
            reason: "Extract Summary writes technical metadata that the headline prompt uses for context."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_annotate_hl",
            reason: "Headlines work best after descriptions are written, giving the LLM more context about the scene."
        },
        {
            before: "enable_extract_summary",
            after: "enable_geo_rename",
            reason: "Extract Summary should run before renaming so the summary is written while files still have their original names."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_geo_rename",
            reason: "Annotations should complete before geo-renaming files, so metadata is fully written under the original filenames."
        },
        {
            before: "enable_annotate_kw",
            after: "enable_geo_rename",
            reason: "Keywords should be written before geo-renaming files."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_contact_sheet",
            reason: "Contact sheet captions use IPTC/EXIF descriptions. Annotate first so captions include the generated text."
        },
        {
            before: "enable_annotate_kw",
            after: "enable_contact_sheet",
            reason: "Generate keywords before the contact sheet so keyword metadata is available for captions."
        },
        {
            before: "enable_extract_summary",
            after: "enable_contact_sheet",
            reason: "Extract Summary should run before Contact Sheet so the summary text is available for captions."
        },
        {
            before: "enable_extract_summary",
            after: "enable_scrub",
            reason: "Scrub clears metadata fields that Extract Summary writes to. Run Extract Summary first or the summary will be erased."
        },
        {
            before: "enable_annotate_desc",
            after: "enable_scrub",
            reason: "Scrub clears metadata fields that description annotation writes to. Annotate first or the descriptions will be erased."
        },
        {
            before: "enable_annotate_kw",
            after: "enable_scrub",
            reason: "Scrub clears keyword fields. Generate keywords first or they will be erased."
        },
        {
            before: "enable_contact_sheet",
            after: "enable_scrub",
            reason: "Contact sheet reads metadata for captions. Generate the contact sheet before scrubbing fields."
        },
        {
            before: "enable_geo_rename",
            after: "enable_scrub",
            reason: "Geo Rename should complete before scrubbing, as scrubbing may remove metadata that rename needs."
        }
    ];

    // Track selection order (keys in the order the user checked them)
    var selectionOrder = [];
    var orderWarningEl = document.getElementById("order-warning");

    // All step badges indexed by key
    var stepBadges = {};
    document.querySelectorAll(".step-badge[data-step-key]").forEach(function(el) {
        stepBadges[el.getAttribute("data-step-key")] = el;
    });

    function updateStepSequencing() {
        // Build the current selection order from selectionOrder
        // (only keep keys that are still checked)
        var activeOrder = [];
        for (var i = 0; i < selectionOrder.length; i++) {
            var key = selectionOrder[i];
            var cb = document.querySelector('input[name="' + key + '"]');
            if (cb && cb.checked) {
                activeOrder.push(key);
            }
        }
        selectionOrder = activeOrder;

        // Update all badges: show sequence number or reset
        for (var key in stepBadges) {
            var badge = stepBadges[key];
            var idx = activeOrder.indexOf(key);
            if (idx >= 0) {
                badge.textContent = "Step " + (idx + 1);
                badge.style.display = "";
                badge.classList.remove("step-warn");
            } else {
                badge.textContent = "";
                badge.style.display = "none";
                badge.classList.remove("step-warn");
            }
        }

        // Check ordering violations
        var issues = [];
        for (var r = 0; r < ORDER_RULES.length; r++) {
            var rule = ORDER_RULES[r];
            var posB = activeOrder.indexOf(rule.before);
            var posA = activeOrder.indexOf(rule.after);
            // Only flag if both are selected and order is wrong
            if (posB >= 0 && posA >= 0 && posB > posA) {
                issues.push({
                    before: rule.before,
                    after: rule.after,
                    reason: rule.reason,
                    posB: posB,
                    posA: posA
                });
                // Mark both badges
                stepBadges[rule.before].classList.add("step-warn");
                stepBadges[rule.after].classList.add("step-warn");
            }
        }

        // Compute suggested order for reuse
        var suggested = activeOrder.slice().sort(function(a, b) {
            return (STEP_RECOMMENDED_ORDER[a] || 99) - (STEP_RECOMMENDED_ORDER[b] || 99);
        });

        // Render the order warning
        if (issues.length === 0) {
            orderWarningEl.style.display = "none";
            orderWarningEl.classList.remove("expanded");
            orderOverride = false;
            return;
        }

        // Reset override when issues change
        orderOverride = false;

        var html = '<div class="ow-header" onclick="this.parentElement.classList.toggle(\'expanded\')">';
        html += '<i class="bi bi-shuffle"></i> ';
        html += issues.length + ' step ordering ' + (issues.length === 1 ? 'concern' : 'concerns');
        html += ' <i class="bi bi-chevron-down" style="font-size:.65rem;margin-left:.3rem"></i>';
        html += '</div>';
        html += '<div class="ow-detail">';

        for (var j = 0; j < issues.length; j++) {
            var iss = issues[j];
            html += '<div class="ow-issue">';
            html += '<i class="bi bi-shuffle" style="font-size:.7rem"></i> ';
            html += '<strong>' + STEP_LABELS[iss.before] + '</strong>';
            html += ' (step ' + (iss.posB + 1) + ')';
            html += ' is typically run before ';
            html += '<strong>' + STEP_LABELS[iss.after] + '</strong>';
            html += ' (step ' + (iss.posA + 1) + ')';
            html += '</div>';
            html += '<div class="ow-issue" style="padding-left:1.1rem;color:#999;font-size:.75rem">';
            html += iss.reason;
            html += '</div>';
        }

        // Suggested order
        html += '<div class="ow-suggestion">';
        html += '<i class="bi bi-lightbulb" style="font-size:.7rem"></i> Suggested order: ';
        for (var k = 0; k < suggested.length; k++) {
            if (k > 0) html += ' &rarr; ';
            html += STEP_LABELS[suggested[k]];
        }
        html += '</div>';

        // Action buttons
        html += '<div class="ow-actions">';
        html += '<button type="button" class="btn btn-sm ow-btn-reorder" id="btn-use-suggested">';
        html += '<i class="bi bi-arrow-repeat"></i> Use suggested order</button>';
        html += '<button type="button" class="btn btn-sm ow-btn-override" id="btn-override-order">';
        html += '<i class="bi bi-unlock"></i> Keep my order</button>';
        html += '</div>';

        html += '</div>';

        orderWarningEl.innerHTML = html;
        orderWarningEl.style.display = "block";

        // Wire up the "Use suggested order" button
        document.getElementById("btn-use-suggested").addEventListener("click", function() {
            selectionOrder = suggested.slice();
            updateStepSequencing();
        });

        // Wire up the "Keep my order" override button
        document.getElementById("btn-override-order").addEventListener("click", function() {
            orderOverride = true;
            orderWarningEl.classList.add("ow-overridden");
            var overMsg = orderWarningEl.querySelector(".ow-override-msg");
            if (!overMsg) {
                var div = document.createElement("div");
                div.className = "ow-override-msg";
                div.innerHTML = '<i class="bi bi-exclamation-triangle"></i> '
                    + 'Order override active. The selected step sequence may produce '
                    + 'unexpected results if dependencies are not met.';
                orderWarningEl.querySelector(".ow-detail").appendChild(div);
            }
            // Hide action buttons after override
            var actions = orderWarningEl.querySelector(".ow-actions");
            if (actions) actions.style.display = "none";
        });
    }

    // Returns an object with validation results for pre-run check
    function validateWorkflow() {
        var result = { valid: true, errors: [], warnings: [] };
        var data = collectFormData();

        // 1) Folder check
        if (!data.photo_dir) {
            result.valid = false;
            result.errors.push("No photo directory specified.");
        } else if (!folderValid) {
            result.valid = false;
            result.errors.push("Photo directory has not been validated. Click the check button or type a valid path.");
        }

        // 2) At least one step
        var activeSteps = selectionOrder.filter(function(key) {
            return data[key];
        });
        if (activeSteps.length === 0) {
            result.valid = false;
            result.errors.push("No workflow steps are enabled.");
            return result;
        }

        // 3) Ordering issues
        var issues = [];
        for (var r = 0; r < ORDER_RULES.length; r++) {
            var rule = ORDER_RULES[r];
            var posB = activeSteps.indexOf(rule.before);
            var posA = activeSteps.indexOf(rule.after);
            if (posB >= 0 && posA >= 0 && posB > posA) {
                issues.push(rule);
            }
        }

        if (issues.length > 0 && !orderOverride) {
            result.valid = false;
            result.errors.push(
                issues.length + " step ordering " + (issues.length === 1 ? "concern" : "concerns")
                + " detected. Use the suggested order or click \"Keep my order\" to override."
            );
        } else if (issues.length > 0 && orderOverride) {
            result.warnings.push(
                "Running with " + issues.length + " order " + (issues.length === 1 ? "override" : "overrides")
                + ". Results may differ from expected behavior."
            );
        }

        // 5) Logical warnings (non-blocking)
        if (data.enable_scrub && (data.enable_annotate_desc || data.enable_annotate_kw || data.enable_extract_summary)) {
            var scrubPos = activeSteps.indexOf("enable_scrub");
            var writeSteps = ["enable_annotate_desc", "enable_annotate_kw", "enable_extract_summary"];
            var anyWriteAfter = writeSteps.some(function(ws) {
                var p = activeSteps.indexOf(ws);
                return p >= 0 && p > scrubPos;
            });
            if (anyWriteAfter) {
                result.warnings.push("Scrub Metadata is scheduled before a step that writes metadata. The scrubbed fields will be overwritten.");
            }
        }

        if (data.enable_geo_rename && data.enable_extract_summary) {
            var renPos = activeSteps.indexOf("enable_geo_rename");
            var sumPos = activeSteps.indexOf("enable_extract_summary");
            if (renPos >= 0 && sumPos >= 0 && renPos < sumPos) {
                result.warnings.push("Geo Rename will change filenames before Extract Summary runs. Summary log output will reference the new filenames.");
            }
        }

        return result;
    }

    // ---- Sidebar step clicking: show config in inspector ----

    var activeStepKey = "";  // track which step is currently shown

    function closeInspector() {
        // Return any currently-displayed config panel to its hidden state
        var currentConfig = inspectorContent.querySelector(".step-config");
        if (currentConfig) {
            currentConfig.style.display = "none";
            form.appendChild(currentConfig);
        }
        document.querySelectorAll(".sidebar-step").forEach(function(s) {
            s.classList.remove("active");
        });
        inspectorTitle.textContent = "Select a workflow step";
        activeStepKey = "";
    }

    document.querySelectorAll(".sidebar-step").forEach(function(el) {
        el.addEventListener("click", function(e) {
            // Don't navigate inspector when clicking checkbox, tooltip, or docs link
            if (e.target.classList.contains("form-check-input") ||
                e.target.classList.contains("step-tooltip") ||
                e.target.classList.contains("step-docs-link")) {
                return;
            }
            var stepKey = el.dataset.step;
            var enableKey = SIDEBAR_STEP_MAP[stepKey];

            // Toggle: clicking the same step again closes the inspector
            if (activeStepKey === stepKey) {
                closeInspector();
                return;
            }

            // Close any open panel first
            closeInspector();

            el.classList.add("active");
            activeStepKey = stepKey;

            // Show the selected config in the inspector
            var configId = STEP_CONFIG_MAP[enableKey];
            var config = configId ? document.getElementById(configId) : null;
            if (config) {
                inspectorContent.appendChild(config);
                config.style.display = "block";
                inspectorTitle.textContent = STEP_LABELS[enableKey] || stepKey;
            } else {
                inspectorTitle.textContent = STEP_LABELS[enableKey] || stepKey;
            }
        });
    });

    // Close inspector when clicking outside sidebar steps and inspector
    document.querySelector(".app-main").addEventListener("click", function(e) {
        if (!activeStepKey) return;
        // Don't close if clicking inside the inspector panel itself
        if (inspectorPanel.contains(e.target)) return;
        closeInspector();
    });

    // ---- Toggle step enable/disable based on checkboxes ----

    document.querySelectorAll(".section-toggle").forEach(function(cb) {
        function syncState() {
            if (cb.checked) {
                // Track selection order: append if not already present
                if (selectionOrder.indexOf(cb.name) === -1) {
                    selectionOrder.push(cb.name);
                }
            } else {
                // Remove from selection order
                var idx = selectionOrder.indexOf(cb.name);
                if (idx >= 0) selectionOrder.splice(idx, 1);
            }
            updateStepSequencing();
        }

        cb.addEventListener("change", function(e) {
            e.stopPropagation(); // Don't trigger sidebar-step click
            syncState();
        });
        syncState();
    });

    // ---- Header meta update ----

    function updateHeaderMeta(stats) {
        var meta = document.getElementById("header-meta");
        if (!meta) return;
        if (!stats) { meta.innerHTML = ''; return; }
        meta.innerHTML = '';
        // Path
        if (photoDirInput.value) {
            var pathEl = document.createElement('span');
            pathEl.className = 'header-meta-item';
            pathEl.textContent = photoDirInput.value;
            meta.appendChild(pathEl);
        }
        // Photo count
        if (stats.total !== undefined) {
            var countEl = document.createElement('span');
            countEl.className = 'header-meta-item';
            countEl.textContent = stats.total + ' photos';
            meta.appendChild(countEl);
        }
        // GPS %
        if (stats.pct_gps !== undefined) {
            var gpsEl = document.createElement('span');
            gpsEl.className = 'header-meta-item';
            gpsEl.textContent = stats.pct_gps + '% GPS';
            meta.appendChild(gpsEl);
        }
        // Date range
        if (stats.date_min && stats.date_max) {
            var dateEl = document.createElement('span');
            dateEl.className = 'header-meta-item';
            dateEl.textContent = formatExifDateRange(stats.date_min, stats.date_max);
            meta.appendChild(dateEl);
        }
    }

    // ---- Pipeline strip ----

    function updatePipelineStrip(steps, currentStep, status) {
        var strip = document.getElementById("pipeline-strip");
        if (!strip) return;
        strip.style.display = "flex";
        strip.innerHTML = '';
        for (var i = 0; i < steps.length; i++) {
            if (i > 0) {
                var conn = document.createElement('div');
                conn.className = 'pipeline-connector';
                strip.appendChild(conn);
            }
            var node = document.createElement('div');
            node.className = 'pipeline-node';
            if (status === 'done' || i < currentStep) {
                node.classList.add('done');
                node.innerHTML = '<i class="bi bi-check-circle-fill"></i> ' + escapeHtml(steps[i]);
            } else if (i === currentStep && status === 'running') {
                node.classList.add('running');
                node.innerHTML = '<i class="bi bi-arrow-repeat"></i> ' + escapeHtml(steps[i]);
            } else if ((status === 'failed' || status === 'cancelled') && i === currentStep) {
                node.classList.add('failed');
                node.innerHTML = '<i class="bi bi-x-circle-fill"></i> ' + escapeHtml(steps[i]);
            } else {
                node.innerHTML = '&#9675; ' + escapeHtml(steps[i]);
            }
            strip.appendChild(node);
        }
    }

    // ---- Folder Validation ----

    function setFolderStatus(html, cls) {
        folderStatus.innerHTML = html;
        folderStatus.className = "mt-1 " + (cls || "");
    }

    var lastResolvedPath = "";

    function validateFolder(path) {
        if (!path) {
            lastResolvedPath = "";
            setFolderStatus("");
            hideFolderMetaStats();
            hidePhotoThumbs();
            hideContentViewTabs();
            hideBackupRow();
            photoDirInput.classList.remove("is-valid", "is-invalid");
            folderValid = false;
            updateHeaderMeta(null);
            return;
        }

        setFolderStatus('<i class="bi bi-hourglass-split"></i> Checking...', "text-secondary");

        fetch("/api/validate_folder?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (!data.valid) {
                    lastResolvedPath = "";
                    setFolderStatus(
                        '<i class="bi bi-x-circle-fill"></i> ' + data.reason,
                        "text-danger"
                    );
                    photoDirInput.classList.remove("is-valid");
                    photoDirInput.classList.add("is-invalid");
                    folderValid = false;
                    updateHeaderMeta(null);
                    hidePhotoThumbs();
                    hideContentViewTabs();
            hideBackupRow();
                } else {
                    var resolvedPath = data.path;
                    var isNewPath = resolvedPath !== lastResolvedPath;
                    lastResolvedPath = resolvedPath;

                    if (data.warning) {
                        setFolderStatus(
                            '<i class="bi bi-exclamation-triangle-fill"></i> ' + data.warning +
                            ' <span class="text-muted">(resolved: ' + resolvedPath + ')</span>',
                            "text-warning"
                        );
                    } else {
                        setFolderStatus(
                            '<i class="bi bi-check-circle-fill"></i> ' +
                            data.photo_count + ' photo file' + (data.photo_count !== 1 ? 's' : '') +
                            ' found <span class="text-muted">(resolved: ' + resolvedPath + ')</span>',
                            "text-success"
                        );
                    }
                    photoDirInput.classList.remove("is-invalid");
                    photoDirInput.classList.add("is-valid");
                    folderValid = true;
                    autoDefaultMaxPerSheet(data.photo_count);
                    showContentViewTabs();
                    showBackupRow();

                    // Store detected subfolders for project mode
                    detectedSubfolders = data.subfolders || [];
                    if (detectedSubfolders.length > 0 && data.photo_count === 0) {
                        var totalSub = detectedSubfolders.reduce(function(s, f) { return s + f.photo_count; }, 0);
                        setFolderStatus(
                            '<i class="bi bi-folder2-open"></i> Project folder: ' +
                            detectedSubfolders.length + ' subfolder' + (detectedSubfolders.length !== 1 ? 's' : '') +
                            ' with ' + totalSub + ' total photos' +
                            ' <span class="text-muted">(resolved: ' + resolvedPath + ')</span>',
                            "text-success"
                        );
                    }

                    // Only reload data if the resolved path actually changed
                    if (isNewPath) {
                        fetchFolderMetaStats(resolvedPath);
                        fetchPhotoThumbs(resolvedPath, 1);
                        resetMapState();
                        checkBlurResultsAvailable(resolvedPath);
                        checkUndoAvailable(resolvedPath);
                    }
                }
            })
            .catch(function() {
                lastResolvedPath = "";
                setFolderStatus(
                    '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                    "text-danger"
                );
                folderValid = false;
                updateHeaderMeta(null);
                hidePhotoThumbs();
                hideContentViewTabs();
            hideBackupRow();
            });
    }

    function autoDefaultMaxPerSheet(photoCount) {
        var input = document.getElementById("cs-max-per-sheet");
        if (!input) return;
        // Only auto-set if the user hasn't manually changed it from the default
        var current = parseInt(input.value, 10);
        if (current === 0 && photoCount > 60) {
            input.value = "60";
        }
    }

    function hideFolderMetaStats() {
        folderMetaStats.style.display = "none";
        folderMetaStats.innerHTML = "";
    }

    function fetchFolderMetaStats(resolvedPath) {
        lastMetaPath = resolvedPath;
        folderMetaStats.innerHTML = '<span class="text-muted"><i class="bi bi-hourglass-split"></i> Scanning metadata...</span>';
        folderMetaStats.style.display = "block";

        fetch("/api/folder_meta?path=" + encodeURIComponent(resolvedPath))
            .then(function(res) {
                return res.json().then(function(data) {
                    return {ok: res.ok, data: data};
                });
            })
            .then(function(result) {
                if (!result.ok || result.data.error) {
                    var msg = (result.data && result.data.error) || "HTTP error";
                    folderMetaStats.innerHTML = '';
                    var span = document.createElement('span');
                    span.className = 'text-muted';
                    var warnIcon = document.createElement('i');
                    warnIcon.className = 'bi bi-exclamation-triangle';
                    span.appendChild(warnIcon);
                    span.appendChild(document.createTextNode(' ' + msg));
                    folderMetaStats.appendChild(span);
                    return;
                }
                renderFolderMetaStats(result.data);
                // Update header meta with stats
                updateHeaderMeta(result.data);
            })
            .catch(function(err) {
                folderMetaStats.innerHTML = '';
                var span = document.createElement('span');
                span.className = 'text-muted';
                var warnIcon = document.createElement('i');
                warnIcon.className = 'bi bi-exclamation-triangle';
                span.appendChild(warnIcon);
                span.appendChild(document.createTextNode(' Metadata scan unavailable: ' + (err.message || err)));
                folderMetaStats.appendChild(span);
            });
    }

    var lastMetaPath = "";  // track resolved path for "scan all" button

    function renderFolderMetaStats(d) {
        var isSampled = d.sampled < d.total;
        var sampleNote = isSampled
            ? " (sampled " + d.sampled + " of " + d.total + ")"
            : " (" + d.total + " files)";

        folderMetaStats.innerHTML = "";
        folderMetaStats.style.display = "block";

        var label = document.createElement("span");
        label.className = "fms-label";
        label.textContent = "Metadata coverage" + sampleNote + ":";
        folderMetaStats.appendChild(label);

        var statsHtml =
            renderMetaStat("bi-geo-alt-fill", "GPS", d.has_gps, d.sampled, d.pct_gps) +
            renderMetaStat("bi-card-text", "IPTC Caption", d.has_caption, d.sampled, d.pct_caption) +
            renderMetaStat("bi-chat-square-text", "UserComment", d.has_comment, d.sampled, d.pct_comment) +
            renderMetaStat("bi-tags-fill", "Keywords", d.has_keywords || 0, d.sampled, d.pct_keywords || 0);

        // Date range
        if (d.date_min && d.date_max) {
            var dateStr = formatExifDateRange(d.date_min, d.date_max);
            statsHtml += '<span class="fms-stat" style="color:var(--ps-text)">'
                + '<i class="bi bi-calendar-range"></i> ' + dateStr + '</span>';
        }

        // Camera breakdown
        if (d.cameras && Object.keys(d.cameras).length > 0) {
            var cameraStr = formatCameraBreakdown(d.cameras);
            statsHtml += '<span class="fms-stat" style="color:var(--ps-text)" title="'
                + formatCameraFull(d.cameras) + '">'
                + '<i class="bi bi-camera"></i> ' + cameraStr + '</span>';
        }

        folderMetaStats.insertAdjacentHTML("beforeend", statsHtml);

        // Show "Scan all" button if this was a sample
        if (isSampled && lastMetaPath) {
            var scanBtn = document.createElement("button");
            scanBtn.type = "button";
            scanBtn.className = "btn btn-sm btn-photoshell";
            scanBtn.style.marginLeft = "auto";
            scanBtn.style.fontSize = "11px";
            scanBtn.style.padding = "2px 8px";
            scanBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Scan all ' + d.total;
            scanBtn.addEventListener("click", function() {
                scanBtn.disabled = true;
                scanBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Scanning...';
                fetch("/api/folder_meta?path=" + encodeURIComponent(lastMetaPath) + "&limit=0")
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        if (data.error) {
                            scanBtn.textContent = "Error: " + data.error;
                            return;
                        }
                        renderFolderMetaStats(data);
                        updateHeaderMeta(data);
                    })
                    .catch(function() {
                        scanBtn.textContent = "Scan failed";
                    });
            });
            folderMetaStats.appendChild(scanBtn);
        }
    }

    function formatExifDate(dto) {
        // EXIF format: "YYYY:MM:DD HH:MM:SS" → "Mon DD, YYYY"
        if (!dto) return "";
        var parts = dto.split(" ")[0].split(":");
        if (parts.length < 3) return dto;
        var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        var m = parseInt(parts[1], 10) - 1;
        var d = parseInt(parts[2], 10);
        return months[m] + " " + d + ", " + parts[0];
    }

    function formatExifDateRange(dmin, dmax) {
        var minDate = dmin.split(" ")[0];
        var maxDate = dmax.split(" ")[0];
        if (minDate === maxDate) return formatExifDate(dmin);
        // Same year? Shorten
        var minParts = minDate.split(":");
        var maxParts = maxDate.split(":");
        var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        var mMin = parseInt(minParts[1], 10) - 1;
        var dMin = parseInt(minParts[2], 10);
        var mMax = parseInt(maxParts[1], 10) - 1;
        var dMax = parseInt(maxParts[2], 10);
        if (minParts[0] === maxParts[0]) {
            return months[mMin] + " " + dMin + " \u2013 " + months[mMax] + " " + dMax + ", " + minParts[0];
        }
        return formatExifDate(dmin) + " \u2013 " + formatExifDate(dmax);
    }

    function formatCameraBreakdown(cameras) {
        var sorted = Object.keys(cameras).sort(function(a, b) { return cameras[b] - cameras[a]; });
        var parts = [];
        var shown = Math.min(sorted.length, 2);
        for (var i = 0; i < shown; i++) {
            parts.push(sorted[i] + " (" + cameras[sorted[i]] + ")");
        }
        if (sorted.length > shown) {
            parts.push("+" + (sorted.length - shown) + " more");
        }
        return parts.join(", ");
    }

    function formatCameraFull(cameras) {
        var sorted = Object.keys(cameras).sort(function(a, b) { return cameras[b] - cameras[a]; });
        return sorted.map(function(m) { return m + ": " + cameras[m]; }).join(", ");
    }

    function renderMetaStat(icon, label, count, total, pct) {
        var cls = "fms-none";
        if (pct >= 80) cls = "fms-good";
        else if (pct > 0) cls = "fms-partial";
        return '<span class="fms-stat ' + cls + '">'
            + '<i class="bi ' + icon + '"></i> '
            + label + ': ' + count + '/' + total
            + ' <small>(' + pct + '%)</small>'
            + '</span>';
    }

    // ---- Workflow Presets ----

    var presetSelect = document.getElementById("preset-select");
    var presetControls = document.getElementById("preset-controls");
    var btnPresetSave = document.getElementById("btn-preset-save");
    var btnPresetDelete = document.getElementById("btn-preset-delete");

    function fetchPresets() {
        fetch("/api/presets")
            .then(function(res) { return res.json(); })
            .then(function(data) {
                presetSelect.innerHTML = '<option value="">— No preset —</option>';
                (data.presets || []).forEach(function(name) {
                    var opt = document.createElement("option");
                    opt.value = name;
                    opt.textContent = name;
                    presetSelect.appendChild(opt);
                });
                presetControls.style.display = "";
            })
            .catch(function() { /* presets unavailable */ });
    }

    presetSelect.addEventListener("change", function() {
        var name = presetSelect.value;
        if (!name) return;
        fetch("/api/presets/" + encodeURIComponent(name))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) return;
                applyPreset(data.config || {});
            });
    });

    function applyPreset(config) {
        // Fill form fields from preset config
        Object.keys(config).forEach(function(key) {
            var el = document.querySelector('[name="' + key + '"]');
            if (!el) return;
            if (el.type === "checkbox") {
                el.checked = !!config[key];
            } else {
                el.value = config[key] || "";
            }
        });
    }

    btnPresetSave.addEventListener("click", function() {
        var name = prompt("Preset name (letters, numbers, hyphens, underscores):");
        if (!name) return;
        name = name.trim().replace(/\s+/g, "-");
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            alert("Invalid name. Use only letters, numbers, hyphens, underscores.");
            return;
        }
        var config = collectFormData();
        delete config.photo_dir;
        delete config.step_order;

        fetch("/api/presets", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({name: name, config: config})
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.ok) {
                fetchPresets();
                presetSelect.value = name;
            } else {
                alert(data.error || "Failed to save preset");
            }
        });
    });

    btnPresetDelete.addEventListener("click", function() {
        var name = presetSelect.value;
        if (!name) return;
        if (!confirm("Delete preset \"" + name + "\"?")) return;
        fetch("/api/presets/" + encodeURIComponent(name), {method: "DELETE"})
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.ok) fetchPresets();
            });
    });

    // Load presets on page load
    fetchPresets();

    // ---- Undo / Revert ----

    var btnUndo = document.getElementById("btn-undo");

    function checkUndoAvailable(resolvedPath) {
        fetch("/api/undo/check?path=" + encodeURIComponent(resolvedPath))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                btnUndo.style.display = data.available ? "" : "none";
            })
            .catch(function() {
                btnUndo.style.display = "none";
            });
    }

    btnUndo.addEventListener("click", function() {
        var path = lastResolvedPath;
        if (!path) return;
        if (!confirm("Restore metadata from backup files in this folder?\nThis will undo the last exiftool changes.")) return;

        btnUndo.disabled = true;
        btnUndo.innerHTML = '<i class="bi bi-hourglass-split"></i> Restoring...';

        fetch("/api/undo", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: path})
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            btnUndo.disabled = false;
            btnUndo.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> Undo';
            if (data.ok) {
                alert("Restored " + data.files_restored + " file(s) from backup.");
                btnUndo.style.display = "none";
                // Refresh metadata stats
                if (lastResolvedPath) fetchFolderMetaStats(lastResolvedPath);
            } else {
                alert(data.error || "Undo failed");
            }
        })
        .catch(function() {
            btnUndo.disabled = false;
            btnUndo.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> Undo';
            alert("Undo request failed");
        });
    });

    // ---- Metadata Replace field discovery ----

    document.getElementById("btn-mr-discover").addEventListener("click", function() {
        var dir = lastResolvedPath || photoDirInput.value.trim();
        if (!dir) { alert("Validate a folder first."); return; }

        var status = document.getElementById("mr-discover-status");
        var cbContainer = document.getElementById("mr-field-checkboxes");
        status.innerHTML = '<i class="bi bi-hourglass-split"></i> Scanning...';

        fetch("/api/discover_text_fields?path=" + encodeURIComponent(dir))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) { status.textContent = data.error; return; }
                status.innerHTML = '<span style="color:var(--ps-success)">' + data.sampled + ' files sampled</span>';

                cbContainer.innerHTML = "";
                var fieldsWithData = [];
                data.fields.forEach(function(f) {
                    var lbl = document.createElement("label");
                    lbl.className = "form-check form-check-inline";
                    lbl.style.fontSize = "11px";

                    var cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.className = "form-check-input";
                    cb.value = f.name;
                    cb.dataset.count = f.count;

                    // Auto-check fields that have data
                    if (f.count > 0) {
                        cb.checked = true;
                        fieldsWithData.push(f.name);
                    }

                    cb.addEventListener("change", updateMrFieldsHidden);

                    var text = document.createElement("span");
                    text.className = "form-check-label";
                    var displayName = f.label || f.name;
                    if (f.count > 0) {
                        text.textContent = displayName + " (" + f.count + "/" + data.sampled + ")";
                        text.style.color = "var(--ps-text)";
                    } else {
                        text.textContent = displayName + " (0)";
                        text.style.color = "var(--ps-text-dim)";
                    }

                    lbl.appendChild(cb);
                    lbl.appendChild(text);
                    cbContainer.appendChild(lbl);
                });

                updateMrFieldsHidden();
            })
            .catch(function() { status.textContent = "Discovery failed"; });
    });

    function updateMrFieldsHidden() {
        var cbs = document.querySelectorAll("#mr-field-checkboxes input[type=checkbox]:checked");
        var selected = [];
        cbs.forEach(function(cb) { selected.push(cb.value); });
        document.getElementById("mr-fields-hidden").value = selected.join(",");
    }

    // ---- Quick Backup ----

    var btnQuickBackup = document.getElementById("btn-quick-backup");
    var quickBackupStatus = document.getElementById("quick-backup-status");
    var folderBackupRow = document.getElementById("folder-backup-row");

    // Show backup row after folder validation succeeds
    function showBackupRow() {
        if (folderBackupRow) folderBackupRow.style.cssText = "display:flex !important";
    }
    function hideBackupRow() {
        if (folderBackupRow) folderBackupRow.style.cssText = "display:none !important";
    }

    btnQuickBackup.addEventListener("click", function() {
        var dir = lastResolvedPath;
        if (!dir) { alert("Validate a folder first."); return; }
        var recursive = document.getElementById("backup-recursive-chk").checked;

        btnQuickBackup.disabled = true;
        quickBackupStatus.innerHTML = '<i class="bi bi-hourglass-split"></i> Creating archive...';

        fetch("/api/quick_backup", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: dir, recursive: recursive})
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.error) {
                quickBackupStatus.innerHTML = '<span style="color:var(--ps-danger)">' + data.error + '</span>';
                btnQuickBackup.disabled = false;
                return;
            }
            // Poll for completion
            var jobId = data.job_id;
            var pollTimer = setInterval(function() {
                fetch("/api/status/" + jobId)
                    .then(function(r) { return r.json(); })
                    .then(function(d) {
                        if (d.status !== "running") {
                            clearInterval(pollTimer);
                            btnQuickBackup.disabled = false;
                            if (d.status === "done") {
                                quickBackupStatus.innerHTML = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle"></i> ' + data.archive + '</span>';
                            } else {
                                quickBackupStatus.innerHTML = '<span style="color:var(--ps-danger)">Backup failed</span>';
                            }
                        }
                    });
            }, 1000);
        })
        .catch(function() {
            quickBackupStatus.innerHTML = '<span style="color:var(--ps-danger)">Request failed</span>';
            btnQuickBackup.disabled = false;
        });
    });

    // ---- Photo thumbnail grid ----

    var RAW_EXTENSIONS = [".dng",".nef",".cr2",".cr3",".arw",".orf",".rw2",".srw",".raf",".pef",".x3f"];

    function initThumbObserver() {
        if (thumbObserver) return;
        thumbObserver = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    var img = entry.target;
                    img.src = img.dataset.src;
                    thumbObserver.unobserve(img);
                }
            });
        }, { rootMargin: "200px" });
    }

    function hidePhotoThumbs() {
        photoThumbsContainer.style.display = "none";
        photoThumbsGrid.innerHTML = "";
        photoThumbsFooter.innerHTML = "";
        thumbFiles = [];
        currentThumbPath = "";
        currentThumbPage = 1;
    }

    function fetchPhotoThumbs(resolvedPath, page) {
        if (!page) page = 1;
        currentThumbPath = resolvedPath;
        currentThumbPage = page;

        if (page === 1) {
            photoThumbsGrid.innerHTML = "";
            photoThumbsFooter.innerHTML = "";
            thumbFiles = [];
            photoThumbsHeader.textContent = "Loading thumbnails\u2026";
            photoThumbsContainer.style.display = "block";
        }

        fetch("/api/photos?path=" + encodeURIComponent(resolvedPath) + "&page=" + page + "&per_page=60")
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    photoThumbsHeader.textContent = data.error;
                    return;
                }
                photoThumbsHeader.textContent = "Photos (" + data.total + ")";
                renderPhotoThumbGrid(data.files, page > 1);
                thumbFiles = thumbFiles.concat(data.files);

                // Enrich thumbnails with catalog metadata (if catalog exists)
                enrichThumbsFromCatalog(resolvedPath, data.files);

                // Load more button
                photoThumbsFooter.innerHTML = "";
                if (data.has_more) {
                    var btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "btn-load-more";
                    btn.textContent = "Load more (" + (data.total - thumbFiles.length) + " remaining)";
                    btn.addEventListener("click", function() {
                        fetchPhotoThumbs(resolvedPath, page + 1);
                    });
                    photoThumbsFooter.appendChild(btn);
                }
            })
            .catch(function(err) {
                photoThumbsHeader.textContent = "Failed to load photos";
            });
    }

    function renderPhotoThumbGrid(files, append) {
        initThumbObserver();
        var frag = document.createDocumentFragment();
        var startIdx = thumbFiles.length;  // index offset for preview modal

        files.forEach(function(file, i) {
            var item = document.createElement("div");
            item.className = "photo-thumb-item";
            item.dataset.idx = startIdx + i;
            item.dataset.filepath = file.path;
            item.title = file.name;

            var isRaw = RAW_EXTENSIONS.indexOf(file.ext) !== -1;
            var img = document.createElement("img");
            img.alt = file.name;
            img.dataset.src = "/api/thumbnail?path=" + encodeURIComponent(file.path) + "&size=200";
            img.src = "";
            img.loading = "lazy";
            item.appendChild(img);
            thumbObserver.observe(img);

            if (isRaw) {
                var badge = document.createElement("span");
                badge.className = "thumb-badge";
                badge.textContent = file.ext.substring(1).toUpperCase();
                item.appendChild(badge);
            }

            item.addEventListener("click", function() {
                openThumbPreview(parseInt(item.dataset.idx, 10));
            });

            frag.appendChild(item);
        });

        photoThumbsGrid.appendChild(frag);
    }

    function enrichThumbsFromCatalog(resolvedPath, files) {
        var paths = files.map(function(f) { return f.path; });
        fetch("/api/catalog/lookup", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: resolvedPath, files: paths})
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.results || Object.keys(data.results).length === 0) return;
            // Find thumb items and add metadata
            photoThumbsGrid.querySelectorAll(".photo-thumb-item").forEach(function(item) {
                var fp = item.dataset.filepath;
                var meta = data.results[fp];
                if (!meta) return;
                // Skip if already enriched
                if (item.querySelector(".thumb-meta")) return;

                var metaDiv = document.createElement("div");
                metaDiv.className = "thumb-meta";

                // Filename
                var fnDiv = document.createElement("div");
                fnDiv.className = "thumb-meta-filename";
                fnDiv.textContent = meta.file_name || "";
                metaDiv.appendChild(fnDiv);

                // Summary line: Model · Date · Focal · Aperture · ISO
                var parts = [];
                if (meta.model) parts.push(meta.model);
                if (meta.date_time_original) parts.push(meta.date_time_original.split(" ")[0]);
                if (meta.focal_length) parts.push(meta.focal_length + "mm");
                if (meta.f_number) parts.push("f/" + meta.f_number);
                if (meta.iso) parts.push("ISO " + meta.iso);
                if (parts.length > 0) {
                    var sumDiv = document.createElement("div");
                    sumDiv.className = "thumb-meta-summary";
                    sumDiv.textContent = parts.join(" \u00b7 ");
                    metaDiv.appendChild(sumDiv);
                }

                item.appendChild(metaDiv);

                // Hover tooltip with caption
                if (meta.caption) {
                    item.title = meta.caption;
                }
            });
        })
        .catch(function() {});
    }

    function openThumbPreview(idx) {
        if (idx < 0 || idx >= thumbFiles.length) return;
        var file = thumbFiles[idx];
        var modalEl = document.getElementById("photoPreviewModal");
        var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        var previewImg = document.getElementById("photo-preview-img");
        var footer = document.getElementById("photo-preview-footer");
        var spinner = modalEl.querySelector(".preview-loading");

        // Hide old image and show spinner
        previewImg.src = "";
        previewImg.style.display = "none";
        previewImg.alt = file.name;
        if (spinner) spinner.style.display = "flex";

        var loader = new Image();
        loader.onload = function() {
            previewImg.src = loader.src;
            previewImg.style.display = "block";
            if (spinner) spinner.style.display = "none";
        };
        loader.onerror = function() {
            previewImg.alt = "Failed to load: " + file.name;
            if (spinner) spinner.style.display = "none";
        };
        loader.src = "/api/thumbnail?path=" + encodeURIComponent(file.path) + "&size=1200";

        // Footer: full path first, then fetch metadata
        footer.innerHTML = "";
        if (file.path) {
            var pathEl = document.createElement("div");
            pathEl.className = "preview-meta-filepath";
            pathEl.textContent = '"' + file.path + '"';
            footer.appendChild(pathEl);
        }

        // Title: filename only
        document.getElementById("photo-preview-title").textContent = file.name;

        // Fetch metadata for the footer (headline, caption, description, keywords)
        fetch("/api/search_meta", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({files: [file.path]})
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.results || data.results.length === 0) return;
            var m = data.results[0];
            var fields = [];
            if (m.headline) fields.push(["Headline", m.headline]);
            if (m.description) fields.push(["Description", m.description]);
            if (m.caption) fields.push(["Caption", m.caption]);
            if (m.comment) fields.push(["Summary", m.comment]);
            if (m.keywords) fields.push(["Keywords", m.keywords]);
            fields.forEach(function(pair) {
                var div = document.createElement("div");
                div.className = "preview-meta-field";
                var label = document.createElement("span");
                label.className = "preview-meta-label";
                label.textContent = pair[0];
                div.appendChild(label);
                div.appendChild(document.createTextNode(pair[1]));
                footer.appendChild(div);
            });
        })
        .catch(function() {});

        // Store current file path for metadata/download buttons
        modalEl.dataset.currentPath = file.path;
        updateDownloadButton(file.path);

        // Reset rotation
        _previewRotation = 0;
        document.getElementById("photo-preview-img").style.transform = "";

        // Hide metadata panel on new preview
        document.getElementById("preview-metadata-panel").style.display = "none";

        modal.show();
    }

    // ---- Preview EXIF/IPTC metadata buttons ----

    function loadFileMetadata(group) {
        var modalEl = document.getElementById("photoPreviewModal");
        var filePath = modalEl.dataset.currentPath;
        if (!filePath) return;

        var panel = document.getElementById("preview-metadata-panel");
        var title = document.getElementById("preview-metadata-title");
        var content = document.getElementById("preview-metadata-content");

        title.textContent = group.toUpperCase() + " Data";
        content.innerHTML = '<span class="text-muted"><i class="bi bi-hourglass-split"></i> Loading...</span>';
        panel.style.display = "block";

        fetch("/api/file_metadata?path=" + encodeURIComponent(filePath) + "&group=" + group)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    content.innerHTML = '<span style="color:var(--ps-danger)">' + escapeHtml(data.error) + '</span>';
                    return;
                }
                var meta = data.metadata || {};
                var keys = Object.keys(meta);
                if (keys.length === 0) {
                    content.innerHTML = '<span class="text-muted">No ' + group.toUpperCase() + ' data found</span>';
                    return;
                }

                var html = '<table>';
                keys.sort().forEach(function(key) {
                    var val = meta[key];
                    if (val === null || val === undefined || val === "") return;
                    // Strip group prefix from key (e.g. "EXIF:Make" -> "Make")
                    var label = key.replace(/^[A-Z]+:/, "");
                    var display = typeof val === "object" ? JSON.stringify(val) : String(val);
                    html += '<tr><td>' + escapeHtml(label) + '</td><td>' + escapeHtml(display) + '</td></tr>';
                });
                html += '</table>';
                content.innerHTML = html;
            })
            .catch(function() {
                content.innerHTML = '<span style="color:var(--ps-danger)">Failed to load metadata</span>';
            });
    }

    document.getElementById("btn-show-exif").addEventListener("click", function() {
        loadFileMetadata("exif");
    });

    document.getElementById("btn-show-iptc").addEventListener("click", function() {
        loadFileMetadata("iptc");
    });

    document.getElementById("btn-close-metadata").addEventListener("click", function() {
        document.getElementById("preview-metadata-panel").style.display = "none";
    });

    // ---- Preview download button ----

    function updateDownloadButton(filePath) {
        var btn = document.getElementById("btn-download-preview");
        if (btn && filePath) {
            btn.href = "/api/download?path=" + encodeURIComponent(filePath);
        }
    }

    // ---- Preview image rotation ----

    var _previewRotation = 0;

    document.getElementById("btn-rotate-preview").addEventListener("click", function() {
        _previewRotation = (_previewRotation + 270) % 360;
        var img = document.getElementById("photo-preview-img");
        if (_previewRotation === 0) {
            img.style.transform = "";
        } else if (_previewRotation === 90 || _previewRotation === 270) {
            // At 90/270 the image is sideways — scale to fit within the container
            // Use the aspect ratio to calculate the right scale factor
            var ratio = img.naturalHeight ? (img.naturalWidth / img.naturalHeight) : 1;
            var scale = ratio > 1 ? (1 / ratio) : ratio;
            img.style.transform = "rotate(" + _previewRotation + "deg) scale(" + scale.toFixed(4) + ")";
        } else {
            img.style.transform = "rotate(" + _previewRotation + "deg)";
        }
    });

    // ---- Content View Tabs ----

    function initContentViewTabs() {
        document.querySelectorAll(".content-tab").forEach(function(tab) {
            tab.addEventListener("click", function() {
                if (tab.disabled) return;
                switchContentView(tab.dataset.view);
            });
        });
    }

    function switchContentView(view) {
        activeContentView = view;
        document.querySelectorAll(".content-tab").forEach(function(t) {
            t.classList.toggle("active", t.dataset.view === view);
        });
        // Toggle inner content views — the parent container stays visible
        var showThumbs = (view === "thumbs") ? "" : "none";
        photoThumbsHeader.style.display = showThumbs;
        photoThumbsGrid.style.display = showThumbs;
        photoThumbsFooter.style.display = showThumbs;
        document.getElementById("map-view").style.display = (view === "map") ? "block" : "none";
        document.getElementById("blur-view").style.display = (view === "blur") ? "block" : "none";

        if (view === "map" && !mapInitialized && currentThumbPath) {
            initMap();
            loadMapData(currentThumbPath);
        }
        if (view === "map" && mapInstance) {
            mapInstance.invalidateSize();
        }
        if (view === "blur" && currentThumbPath) {
            loadBlurResults(currentThumbPath);
        }
    }

    function showContentViewTabs() {
        contentViewTabs.style.display = "flex";
    }

    function hideContentViewTabs() {
        contentViewTabs.style.display = "none";
        activeContentView = "thumbs";
        document.querySelectorAll(".content-tab").forEach(function(t) {
            t.classList.toggle("active", t.dataset.view === "thumbs");
        });
        photoThumbsHeader.style.display = "";
        photoThumbsGrid.style.display = "";
        photoThumbsFooter.style.display = "";
        document.getElementById("map-view").style.display = "none";
        document.getElementById("blur-view").style.display = "none";
    }

    initContentViewTabs();

    // ---- GPS Map View ----

    var CAMERA_COLORS = [
        "#d4845e", "#e09570", "#c9a227", "#6b9b6b", "#7ba3c9",
        "#b07bc9", "#c97b8e", "#8bc97b", "#c9b07b", "#7bc9c2"
    ];

    function getCameraColor(camera) {
        if (!camera) camera = "Unknown";
        if (!cameraColorMap[camera]) {
            cameraColorMap[camera] = CAMERA_COLORS[cameraColorIndex % CAMERA_COLORS.length];
            cameraColorIndex++;
        }
        return cameraColorMap[camera];
    }

    function createColoredIcon(color) {
        return L.divIcon({
            className: "ps-map-marker",
            html: '<div style="background:' + color + ';width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>',
            iconSize: [12, 12],
            iconAnchor: [6, 6]
        });
    }

    function resetMapState() {
        mapInitialized = false;
        currentMapPath = "";
        cameraColorMap = {};
        cameraColorIndex = 0;
        if (mapMarkers) mapMarkers.clearLayers();
        if (mapInstance) { mapInstance.remove(); mapInstance = null; mapMarkers = null; }
    }

    function initMap() {
        var container = document.getElementById("map-container");
        mapInstance = L.map(container).setView([20, 0], 2);
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: '\u00a9 <a href="https://www.openstreetmap.org/copyright">OSM</a> \u00a9 <a href="https://carto.com/">CARTO</a>',
            maxZoom: 19,
            subdomains: "abcd"
        }).addTo(mapInstance);
        mapMarkers = L.markerClusterGroup();
        mapInstance.addLayer(mapMarkers);
        mapInitialized = true;
    }

    function loadMapData(resolvedPath) {
        if (currentMapPath === resolvedPath && mapMarkers && mapMarkers.getLayers().length > 0) return;
        currentMapPath = resolvedPath;

        var banner = document.getElementById("map-coverage-banner");
        banner.textContent = "Loading GPS data\u2026";

        fetch("/api/gps_data?path=" + encodeURIComponent(resolvedPath))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    banner.textContent = data.error;
                    return;
                }
                banner.textContent = data.gps_photos + " of " + data.total_photos + " photos have GPS coordinates";

                var badge = document.getElementById("map-count-badge");
                badge.textContent = data.gps_photos;
                badge.style.display = data.gps_photos > 0 ? "inline" : "none";

                renderMapMarkers(data.markers);
            })
            .catch(function() {
                banner.textContent = "Failed to load GPS data";
            });
    }

    function renderMapMarkers(markers) {
        mapMarkers.clearLayers();
        if (markers.length === 0) return;

        var bounds = [];
        markers.forEach(function(m) {
            var color = getCameraColor(m.camera);
            var icon = createColoredIcon(color);
            var marker = L.marker([m.lat, m.lng], { icon: icon });

            var tooltipHtml = '<div class="ps-map-tooltip">'
                + '<img src="/api/thumbnail?path=' + encodeURIComponent(m.path) + '&size=120" '
                + 'style="width:120px;border-radius:3px;margin-bottom:4px;display:block">'
                + '<div style="font-weight:600;font-size:11px">' + escapeHtml(m.filename) + '</div>'
                + (m.date ? '<div style="font-size:10px;color:#888">' + escapeHtml(formatExifDate(m.date)) + '</div>' : '')
                + (m.camera ? '<div style="font-size:10px;color:#888">' + escapeHtml(m.camera) + '</div>' : '')
                + '</div>';

            marker.bindPopup(tooltipHtml, { maxWidth: 160, className: "ps-map-popup" });
            mapMarkers.addLayer(marker);
            bounds.push([m.lat, m.lng]);
        });

        if (bounds.length > 0) {
            mapInstance.fitBounds(bounds, { padding: [30, 30] });
        }
    }

    function checkBlurResultsAvailable(resolvedPath) {
        fetch("/api/blur_results?path=" + encodeURIComponent(resolvedPath))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                document.getElementById("tab-blur").disabled = !data.has_results;
            })
            .catch(function() {
                document.getElementById("tab-blur").disabled = true;
            });
    }

    // ---- Blur Before/After ----

    function loadBlurResults(resolvedPath) {
        fetch("/api/blur_results?path=" + encodeURIComponent(resolvedPath))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (!data.has_results || !data.scenes || data.scenes.length === 0) {
                    document.getElementById("blur-empty-state").style.display = "flex";
                    document.getElementById("blur-comparison").style.display = "none";
                    return;
                }
                document.getElementById("blur-empty-state").style.display = "none";
                document.getElementById("blur-comparison").style.display = "block";
                blurScenes = data.scenes.filter(function(s) {
                    return s.analyzed && s.analyzed.length >= 2;
                });
                if (blurScenes.length === 0) {
                    document.getElementById("blur-empty-state").style.display = "flex";
                    document.getElementById("blur-comparison").style.display = "none";
                    return;
                }
                renderBlurSceneNav();
                renderBlurScene(0);
            })
            .catch(function() {
                document.getElementById("blur-empty-state").style.display = "flex";
                document.getElementById("blur-comparison").style.display = "none";
            });
    }

    function renderBlurSceneNav() {
        var nav = document.getElementById("blur-scene-nav");
        nav.innerHTML = "";
        if (blurScenes.length <= 1) return;

        // Prev button
        var btnPrev = document.createElement("button");
        btnPrev.type = "button";
        btnPrev.className = "blur-scene-btn blur-scene-arrow";
        btnPrev.innerHTML = '<i class="bi bi-chevron-left"></i>';
        btnPrev.title = "Previous scene";
        btnPrev.addEventListener("click", function() {
            if (currentBlurScene > 0) {
                renderBlurScene(currentBlurScene - 1);
                updateBlurSceneNav();
            }
        });
        nav.appendChild(btnPrev);

        // Scene dropdown
        var select = document.createElement("select");
        select.className = "blur-scene-select";
        select.id = "blur-scene-select";
        blurScenes.forEach(function(scene, i) {
            var opt = document.createElement("option");
            opt.value = i;
            opt.textContent = "Scene " + (i + 1) + " of " + blurScenes.length + " (" + scene.analyzed.length + " photos)";
            select.appendChild(opt);
        });
        select.addEventListener("change", function() {
            renderBlurScene(parseInt(select.value, 10));
            updateBlurSceneNav();
        });
        nav.appendChild(select);

        // Next button
        var btnNext = document.createElement("button");
        btnNext.type = "button";
        btnNext.className = "blur-scene-btn blur-scene-arrow";
        btnNext.innerHTML = '<i class="bi bi-chevron-right"></i>';
        btnNext.title = "Next scene";
        btnNext.addEventListener("click", function() {
            if (currentBlurScene < blurScenes.length - 1) {
                renderBlurScene(currentBlurScene + 1);
                updateBlurSceneNav();
            }
        });
        nav.appendChild(btnNext);
    }

    function updateBlurSceneNav() {
        var select = document.getElementById("blur-scene-select");
        if (select) select.value = currentBlurScene;
    }

    function renderBlurScene(sceneIndex) {
        currentBlurScene = sceneIndex;
        var scene = blurScenes[sceneIndex];
        if (!scene || !scene.analyzed || scene.analyzed.length < 2) return;

        var sorted = scene.analyzed.slice().sort(function(a, b) { return a.score - b.score; });
        var blurriest = sorted[0];
        var sharpest = sorted[sorted.length - 1];

        document.getElementById("blur-img-left").src = "/api/thumbnail?path=" + encodeURIComponent(blurriest.path) + "&size=2400";
        document.getElementById("blur-img-right").src = "/api/thumbnail?path=" + encodeURIComponent(sharpest.path) + "&size=2400";

        setBlurSliderPosition(50);
        renderBlurFilmstrip(scene);
    }

    function renderBlurFilmstrip(scene) {
        var filmstrip = document.getElementById("blur-filmstrip");
        filmstrip.innerHTML = "";
        if (!scene.analyzed) return;

        var sorted = scene.analyzed.slice().sort(function(a, b) { return a.score - b.score; });
        sorted.forEach(function(item) {
            var thumb = document.createElement("div");
            thumb.className = "blur-filmstrip-item";
            if (item.filename === scene.selected) {
                thumb.classList.add("selected");
            }

            var img = document.createElement("img");
            img.src = "/api/thumbnail?path=" + encodeURIComponent(item.path) + "&size=120";
            img.alt = item.filename;
            thumb.appendChild(img);

            var scoreBadge = document.createElement("span");
            scoreBadge.className = "blur-score-badge";
            scoreBadge.textContent = item.score;
            thumb.appendChild(scoreBadge);

            thumb.addEventListener("click", function() {
                // Click filmstrip item to set as right (sharp) comparison image
                document.getElementById("blur-img-right").src = "/api/thumbnail?path=" + encodeURIComponent(item.path) + "&size=2400";
            });

            filmstrip.appendChild(thumb);
        });
    }

    function setBlurSliderPosition(pct) {
        pct = Math.max(0, Math.min(100, pct));
        document.getElementById("blur-slider-handle").style.left = pct + "%";
        document.getElementById("blur-slider-right").style.clipPath = "inset(0 0 0 " + pct + "%)";
    }

    function initBlurSlider() {
        var handle = document.getElementById("blur-slider-handle");
        var container = document.getElementById("blur-slider-container");

        function onMove(clientX) {
            var rect = container.getBoundingClientRect();
            var pct = ((clientX - rect.left) / rect.width) * 100;
            setBlurSliderPosition(pct);
        }

        handle.addEventListener("mousedown", function(e) {
            e.preventDefault();
            blurSliderDragging = true;
        });

        document.addEventListener("mousemove", function(e) {
            if (!blurSliderDragging) return;
            onMove(e.clientX);
        });

        document.addEventListener("mouseup", function() {
            blurSliderDragging = false;
        });

        handle.addEventListener("touchstart", function() {
            blurSliderDragging = true;
        }, { passive: true });

        document.addEventListener("touchmove", function(e) {
            if (!blurSliderDragging) return;
            onMove(e.touches[0].clientX);
        }, { passive: true });

        document.addEventListener("touchend", function() {
            blurSliderDragging = false;
        });

        container.addEventListener("click", function(e) {
            if (e.target === handle || handle.contains(e.target)) return;
            onMove(e.clientX);
        });
    }

    initBlurSlider();

    // Validate on button click
    btnValidate.addEventListener("click", function() {
        validateFolder(photoDirInput.value.trim());
    });

    // Auto-validate after typing stops (debounced 600ms)
    photoDirInput.addEventListener("input", function() {
        clearTimeout(validateTimer);
        var val = photoDirInput.value.trim();
        if (!val) {
            setFolderStatus("");
            hideFolderMetaStats();
            hidePhotoThumbs();
            hideContentViewTabs();
            hideBackupRow();
            photoDirInput.classList.remove("is-valid", "is-invalid");
            folderValid = false;
            updateHeaderMeta(null);
            return;
        }
        validateTimer = setTimeout(function() {
            validateFolder(val);
        }, 600);
    });

    // Validate immediately on paste (skip the 600ms debounce)
    photoDirInput.addEventListener("paste", function() {
        clearTimeout(validateTimer);
        setTimeout(function() {
            var val = photoDirInput.value.trim();
            if (val) validateFolder(val);
        }, 0);
    });

    // ---- Folder Browser ----

    var browserShowHidden = document.getElementById("browser-show-hidden");

    var browserDriveBar = null;
    var browserBreadcrumb = null;

    function ensureBrowserChrome() {
        if (browserDriveBar) return;
        var container = browserList.parentElement;
        var refNode = browserList;

        browserDriveBar = document.createElement("div");
        browserDriveBar.id = "browser-drive-bar";
        browserDriveBar.className = "browser-drive-bar";
        browserDriveBar.style.display = "none";
        container.insertBefore(browserDriveBar, refNode);

        browserBreadcrumb = document.createElement("div");
        browserBreadcrumb.id = "browser-breadcrumb";
        browserBreadcrumb.className = "browser-breadcrumb";
        container.insertBefore(browserBreadcrumb, refNode);
    }

    function browseToPath(path) {
        ensureBrowserChrome();
        browserList.innerHTML = '<div class="text-muted p-3"><i class="bi bi-hourglass-split"></i> Loading (network mounts may take a moment)...</div>';
        browserPathInput.value = path;

        var url = "/api/browse?path=" + encodeURIComponent(path);
        if (browserShowHidden && browserShowHidden.checked) {
            url += "&hidden=1";
        }
        fetch(url)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    browserList.innerHTML = '<div class="text-danger p-3">'
                        + '<i class="bi bi-exclamation-triangle"></i> '
                        + escapeHtml(data.error) + '</div>';
                    return;
                }

                browserPathInput.value = data.current;

                // Drive bar (Windows / WSL)
                if (data.drives && data.drives.length > 0) {
                    var isWsl = data.platform === "wsl";
                    var driveHtml = '<span class="drive-label"><i class="bi bi-hdd"></i></span>';
                    for (var d = 0; d < data.drives.length; d++) {
                        var drv = data.drives[d];
                        var drvLetter = drv.charAt(0).toLowerCase();
                        var active = "";
                        if (isWsl) {
                            active = data.current.toLowerCase().startsWith("/mnt/" + drvLetter)
                                ? " drive-active" : "";
                        } else {
                            active = data.current.toUpperCase().startsWith(drv.toUpperCase())
                                ? " drive-active" : "";
                        }
                        driveHtml += '<button type="button" class="drive-btn' + active
                            + '" data-drive="' + escapeAttr(drv) + '">'
                            + escapeHtml(drv) + '</button>';
                    }
                    browserDriveBar.innerHTML = driveHtml;
                    browserDriveBar.style.display = "flex";
                    browserDriveBar.querySelectorAll(".drive-btn").forEach(function(btn) {
                        btn.addEventListener("click", function() {
                            browseToPath(btn.dataset.drive + "/");
                        });
                    });
                } else {
                    browserDriveBar.style.display = "none";
                }

                // Breadcrumb
                if (data.breadcrumb && data.breadcrumb.length > 0) {
                    var bcHtml = "";
                    for (var b = 0; b < data.breadcrumb.length; b++) {
                        var seg = data.breadcrumb[b];
                        if (b > 0) bcHtml += '<span class="bc-sep"><i class="bi bi-chevron-right"></i></span>';
                        var isLast = (b === data.breadcrumb.length - 1);
                        bcHtml += '<span class="bc-seg' + (isLast ? " bc-current" : "")
                            + '" data-path="' + escapeAttr(seg.path) + '">'
                            + escapeHtml(seg.name) + '</span>';
                    }
                    browserBreadcrumb.innerHTML = bcHtml;
                    browserBreadcrumb.style.display = "flex";
                    browserBreadcrumb.querySelectorAll(".bc-seg:not(.bc-current)").forEach(function(el) {
                        el.addEventListener("click", function() {
                            browseToPath(el.dataset.path);
                        });
                    });
                } else {
                    browserBreadcrumb.innerHTML = "";
                }

                var html = "";

                // Warning banner
                if (data.warning) {
                    html += '<div class="browser-warning">'
                         + '<i class="bi bi-exclamation-triangle"></i> '
                         + escapeHtml(data.warning) + '</div>';
                }

                // Parent directory link
                if (data.parent) {
                    html += '<div class="browser-item browser-parent" data-path="' +
                            escapeAttr(data.parent) + '">' +
                            '<i class="bi bi-arrow-up-circle"></i> ..' +
                            '</div>';
                }

                // Subdirectories
                if (data.dirs.length === 0 && !data.parent) {
                    html += '<div class="text-muted p-3">No subdirectories</div>';
                }

                for (var i = 0; i < data.dirs.length; i++) {
                    var dirEntry = data.dirs[i];
                    var dirName = typeof dirEntry === "string" ? dirEntry : dirEntry.name;
                    var fullPath = typeof dirEntry === "string" ? dirEntry : dirEntry.path;
                    html += '<div class="browser-item" data-path="' + escapeAttr(fullPath) + '">' +
                            '<i class="bi bi-folder-fill" style="color:var(--ps-text-dim)"></i> ' +
                            escapeHtml(dirName) +
                            '</div>';
                }

                browserList.innerHTML = html;

                browserList.querySelectorAll(".browser-item").forEach(function(el) {
                    el.addEventListener("click", function() {
                        browseToPath(el.dataset.path);
                    });
                });
            })
            .catch(function() {
                browserList.innerHTML = '<div class="text-danger p-3">Failed to load directory</div>';
            });
    }

    function escapeHtml(str) {
        var div = document.createElement("div");
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
                  .replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    btnBrowse.addEventListener("click", function() {
        var startPath = photoDirInput.value.trim() || "/";
        browseToPath(startPath);
        browserModal.show();
    });

    browserGoBtn.addEventListener("click", function() {
        browseToPath(browserPathInput.value.trim() || "/");
    });

    browserShowHidden.addEventListener("change", function() {
        var current = browserPathInput.value.trim() || "/";
        browseToPath(current);
    });

    browserPathInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            browseToPath(browserPathInput.value.trim() || "/");
        }
    });

    browserPathInput.addEventListener("paste", function() {
        setTimeout(function() {
            var val = browserPathInput.value.trim();
            if (val) browseToPath(val);
        }, 0);
    });

    // Track which input the folder browser was opened for.
    var browserTarget = null;

    browserSelectBtn.addEventListener("click", function() {
        var selected = browserPathInput.value.trim();
        if (selected) {
            if (browserTarget === "backup-dest") {
                document.getElementById("backup-dest").value = selected;
            } else if (browserTarget === "search-dir") {
                document.getElementById("search-dir").value = selected;
                validateSearchDir(selected);
            } else if (browserTarget === "search-copy") {
                document.getElementById("search-copy-to").value = selected;
            } else {
                photoDirInput.value = selected;
                validateFolder(selected);
            }
        }
        browserTarget = null;
        browserModal.hide();
    });

    // ---- Search directory browse + validate ----

    var searchDirBrowseBtn = document.getElementById("btn-search-browse-dir");
    var searchDirValidateBtn = document.getElementById("btn-search-validate-dir");
    var searchCopyBrowseBtn = document.getElementById("btn-search-browse-copy");
    var searchDirStatus = document.getElementById("search-dir-status");

    if (searchDirBrowseBtn) {
        searchDirBrowseBtn.addEventListener("click", function() {
            browserTarget = "search-dir";
            var searchDir = document.getElementById("search-dir");
            var startPath = searchDir.value.trim() || photoDirInput.value.trim() || "/";
            browseToPath(startPath);
            browserModal.show();
        });
    }

    if (searchCopyBrowseBtn) {
        searchCopyBrowseBtn.addEventListener("click", function() {
            browserTarget = "search-copy";
            var copyTo = document.getElementById("search-copy-to");
            var startPath = copyTo.value.trim() || photoDirInput.value.trim() || "/";
            browseToPath(startPath);
            browserModal.show();
        });
    }

    function validateSearchDir(path) {
        if (!searchDirStatus) return;
        if (!path) { searchDirStatus.innerHTML = ""; return; }
        searchDirStatus.innerHTML = '<span class="text-muted"><i class="bi bi-arrow-repeat"></i> Checking...</span>';
        fetch("/api/validate_folder?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.valid) {
                    var msg = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle-fill"></i> Valid</span>';
                    if (data.photo_count !== undefined) {
                        msg += ' <span class="text-muted">(' + data.photo_count + ' photos)</span>';
                    }
                    if (data.warning) {
                        msg += '<br><span style="color:var(--ps-warning);font-size:11px"><i class="bi bi-exclamation-triangle"></i> ' + data.warning + '</span>';
                    }
                    if (data.path) {
                        msg += '<br><span class="text-muted" style="font-size:11px">(resolved: ' + data.path + ')</span>';
                    }
                    searchDirStatus.innerHTML = msg;
                } else {
                    searchDirStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle-fill"></i> ' + (data.reason || "Invalid directory") + '</span>';
                }
            })
            .catch(function() {
                searchDirStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle-fill"></i> Validation failed</span>';
            });
    }

    if (searchDirValidateBtn) {
        searchDirValidateBtn.addEventListener("click", function() {
            validateSearchDir(document.getElementById("search-dir").value.trim());
        });
    }

    var searchCopyValidateBtn = document.getElementById("btn-search-validate-copy");
    var searchCopyStatus = document.getElementById("search-copy-status");

    function validateSearchCopy(path) {
        if (!searchCopyStatus) return;
        if (!path) { searchCopyStatus.innerHTML = ""; return; }
        searchCopyStatus.innerHTML = '<span class="text-muted"><i class="bi bi-arrow-repeat"></i> Checking...</span>';
        fetch("/api/validate_folder?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.valid) {
                    var msg = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle-fill"></i> Valid</span>';
                    if (data.path) {
                        msg += ' <span class="text-muted" style="font-size:11px">(resolved: ' + data.path + ')</span>';
                    }
                    searchCopyStatus.innerHTML = msg;
                } else {
                    searchCopyStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle-fill"></i> ' + (data.reason || "Invalid directory") + '</span>';
                }
            })
            .catch(function() {
                searchCopyStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle-fill"></i> Validation failed</span>';
            });
    }

    if (searchCopyValidateBtn) {
        searchCopyValidateBtn.addEventListener("click", function() {
            validateSearchCopy(document.getElementById("search-copy-to").value.trim());
        });
    }

    // ---- Ollama model discovery ----

    var ollamaModelsFetched = false;

    function fetchOllamaModels() {
        if (ollamaModelsFetched) return;
        ollamaModelsFetched = true;

        var selects = document.querySelectorAll(".ollama-model-select");
        var statuses = document.querySelectorAll(".ollama-model-status");
        statuses.forEach(function(s) {
            s.innerHTML = '<span class="text-muted"><i class="bi bi-arrow-repeat"></i> Loading models...</span>';
        });

        fetch("/api/ollama_models")
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    statuses.forEach(function(s) {
                        s.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + data.error + '</span>';
                    });
                    ollamaModelsFetched = false;
                    return;
                }
                var models = data.models || [];
                if (models.length === 0) {
                    statuses.forEach(function(s) {
                        s.innerHTML = '<span style="color:var(--ps-warning)"><i class="bi bi-exclamation-triangle"></i> No models installed</span>';
                    });
                    return;
                }

                selects.forEach(function(sel) {
                    var currentVal = sel.value;
                    sel.innerHTML = "";

                    // Vision models group
                    var visionModels = models.filter(function(m) { return m.vision; });
                    var otherModels = models.filter(function(m) { return !m.vision; });

                    if (visionModels.length > 0) {
                        var vGroup = document.createElement("optgroup");
                        vGroup.label = "Vision models (recommended)";
                        visionModels.forEach(function(m) {
                            var opt = document.createElement("option");
                            opt.value = m.name;
                            opt.textContent = m.name + " (" + m.size_gb + " GB)";
                            vGroup.appendChild(opt);
                        });
                        sel.appendChild(vGroup);
                    }

                    if (otherModels.length > 0) {
                        var oGroup = document.createElement("optgroup");
                        oGroup.label = "Other models";
                        otherModels.forEach(function(m) {
                            var opt = document.createElement("option");
                            opt.value = m.name;
                            opt.textContent = m.name + " (" + m.size_gb + " GB)";
                            oGroup.appendChild(opt);
                        });
                        sel.appendChild(oGroup);
                    }

                    // Restore previous value if it exists, otherwise use server default
                    var found = false;
                    for (var i = 0; i < sel.options.length; i++) {
                        if (sel.options[i].value === currentVal) {
                            sel.value = currentVal;
                            found = true;
                            break;
                        }
                    }
                    if (!found && data.default) {
                        sel.value = data.default;
                    }
                });

                var vCount = models.filter(function(m) { return m.vision; }).length;
                var summary = models.length + " model" + (models.length !== 1 ? "s" : "");
                if (vCount > 0) {
                    summary += " (" + vCount + " vision)";
                }
                statuses.forEach(function(s) {
                    s.innerHTML = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle"></i> ' + summary + '</span>';
                });
            })
            .catch(function(err) {
                statuses.forEach(function(s) {
                    s.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> Failed to load models</span>';
                });
                ollamaModelsFetched = false;
            });
    }

    // Fetch models when an Ollama-based step is clicked
    document.querySelectorAll('.sidebar-step[data-step="desc"], .sidebar-step[data-step="kw"], .sidebar-step[data-step="hl"], .sidebar-step[data-step="mcon"]').forEach(function(el) {
        el.addEventListener("click", function() {
            fetchOllamaModels();
        });
    });

    // ---- Prompt management ----

    var promptCache = {};  // workflow -> [{id, text, source}, ...]

    function _workflowPrefix(workflow) {
        if (workflow === "description") return "desc";
        if (workflow === "keywords") return "kw";
        if (workflow === "headline") return "hl";
        if (workflow === "consistency") return "mcon";
        return workflow;
    }

    function fetchPrompts(workflow) {
        if (promptCache[workflow]) {
            populatePromptSelect(workflow, promptCache[workflow]);
            return;
        }
        fetch("/api/prompts/" + encodeURIComponent(workflow))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) return;
                promptCache[workflow] = data.prompts || [];
                populatePromptSelect(workflow, promptCache[workflow]);
            })
            .catch(function() {});
    }

    function populatePromptSelect(workflow, prompts) {
        var prefix = _workflowPrefix(workflow);
        var sel = document.getElementById(prefix + "-prompt-select");
        if (!sel) return;

        var currentVal = sel.value;
        sel.innerHTML = "";

        prompts.forEach(function(p) {
            var opt = document.createElement("option");
            opt.value = String(p.id);
            var label = p.id + " — " + p.text.substring(0, 80);
            if (p.text.length > 80) label += "...";
            if (p.source === "built-in") label += " (built-in)";
            opt.textContent = label;
            sel.appendChild(opt);
        });

        // Restore selection
        var found = false;
        for (var i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === currentVal) {
                sel.value = currentVal;
                found = true;
                break;
            }
        }
        if (!found && sel.options.length > 0) {
            // Default to first file prompt (id=1) or first available
            var filePrompt = prompts.find(function(p) { return p.source === "file"; });
            sel.value = filePrompt ? String(filePrompt.id) : String(prompts[0].id);
        }

        // Show the selected prompt text
        updatePromptText(workflow);
    }

    function updatePromptText(workflow) {
        var prefix = _workflowPrefix(workflow);
        var sel = document.getElementById(prefix + "-prompt-select");
        var textarea = document.getElementById(prefix + "-prompt-text");
        if (!sel || !textarea) return;

        var prompts = promptCache[workflow] || [];
        var selectedId = sel.value;
        var prompt = prompts.find(function(p) { return String(p.id) === selectedId; });
        textarea.value = prompt ? prompt.text : "";
        textarea.readOnly = true;

        // Reset edit state
        var editBtn = document.getElementById(prefix + "-prompt-edit");
        var saveBtn = document.getElementById(prefix + "-prompt-save");
        var status = document.getElementById(prefix + "-prompt-status");
        if (editBtn) { editBtn.style.display = ""; editBtn.textContent = ""; editBtn.innerHTML = '<i class="bi bi-pencil"></i> Edit'; }
        if (saveBtn) saveBtn.style.display = "none";
        if (status) status.innerHTML = "";
    }

    // Wire up prompt select change events
    document.querySelectorAll(".prompt-select").forEach(function(sel) {
        sel.addEventListener("change", function() {
            updatePromptText(sel.dataset.workflow);
        });
    });

    // Wire up Edit buttons
    document.querySelectorAll(".prompt-edit-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var wf = btn.dataset.workflow;
            var prefix = _workflowPrefix(wf);
            var textarea = document.getElementById(prefix + "-prompt-text");
            var saveBtn = document.getElementById(prefix + "-prompt-save");
            var sel = document.getElementById(prefix + "-prompt-select");

            if (textarea.readOnly) {
                // Enter edit mode
                textarea.readOnly = false;
                textarea.focus();
                textarea.style.borderColor = "var(--ps-accent)";
                btn.innerHTML = '<i class="bi bi-x-circle"></i> Cancel';
                if (saveBtn && sel.value !== "0") saveBtn.style.display = "";
            } else {
                // Cancel edit — restore original text
                textarea.readOnly = true;
                textarea.style.borderColor = "";
                updatePromptText(wf);
            }
        });
    });

    // Wire up Save buttons
    document.querySelectorAll(".prompt-save-btn").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var wf = btn.dataset.workflow;
            var prefix = _workflowPrefix(wf);
            var textarea = document.getElementById(prefix + "-prompt-text");
            var sel = document.getElementById(prefix + "-prompt-select");
            var status = document.getElementById(prefix + "-prompt-status");
            var promptId = sel.value;
            var promptText = textarea.value.trim();

            if (!promptText) {
                if (status) status.innerHTML = '<span style="color:var(--ps-danger)">Prompt text cannot be empty</span>';
                return;
            }
            if (promptId === "0") {
                if (status) status.innerHTML = '<span style="color:var(--ps-danger)">Cannot overwrite built-in prompt</span>';
                return;
            }

            if (status) status.innerHTML = '<span class="text-muted">Saving...</span>';

            fetch("/api/prompts/" + encodeURIComponent(wf) + "/save", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: parseInt(promptId), text: promptText})
            })
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    if (status) status.innerHTML = '<span style="color:var(--ps-danger)">' + data.error + '</span>';
                    return;
                }
                if (status) status.innerHTML = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle"></i> Saved</span>';
                // Update cache and UI
                textarea.readOnly = true;
                textarea.style.borderColor = "";
                btn.style.display = "none";
                var editBtn = document.getElementById(prefix + "-prompt-edit");
                if (editBtn) editBtn.innerHTML = '<i class="bi bi-pencil"></i> Edit';
                // Refresh prompts from server
                delete promptCache[wf];
                fetchPrompts(wf);
                // Clear status after 3s
                setTimeout(function() { if (status) status.innerHTML = ""; }, 3000);
            })
            .catch(function() {
                if (status) status.innerHTML = '<span style="color:var(--ps-danger)">Save failed</span>';
            });
        });
    });

    // Fetch prompts when annotate steps are clicked
    document.querySelectorAll('.sidebar-step[data-step="desc"]').forEach(function(el) {
        el.addEventListener("click", function() { fetchPrompts("description"); });
    });
    document.querySelectorAll('.sidebar-step[data-step="kw"]').forEach(function(el) {
        el.addEventListener("click", function() { fetchPrompts("keywords"); });
    });
    document.querySelectorAll('.sidebar-step[data-step="hl"]').forEach(function(el) {
        el.addEventListener("click", function() { fetchPrompts("headline"); });
    });
    document.querySelectorAll('.sidebar-step[data-step="mcon"]').forEach(function(el) {
        el.addEventListener("click", function() { fetchPrompts("consistency"); });
    });

    // ---- Collect form data ----

    function collectFormData() {
        var data = {};
        // Collect from both the sidebar form AND the inspector panel,
        // since step config panels are moved into the inspector (outside the form)
        var containers = [form, document.getElementById("inspector-content")];
        containers.forEach(function(container) {
            if (!container) return;
            container.querySelectorAll("input[type=text], input[type=number], input[type=hidden], select").forEach(function(el) {
                if (el.name) data[el.name] = el.value.trim();
            });
            container.querySelectorAll("input[type=checkbox]").forEach(function(el) {
                if (el.name) data[el.name] = el.checked;
            });
        });
        // Also collect from any step-config panels still in the form
        // (panels that haven't been clicked/moved to inspector yet)
        document.querySelectorAll(".step-config input[type=text], .step-config input[type=number], .step-config input[type=hidden], .step-config select").forEach(function(el) {
            if (el.name && !(el.name in data)) data[el.name] = el.value.trim();
        });
        document.querySelectorAll(".step-config input[type=checkbox]").forEach(function(el) {
            if (el.name && !(el.name in data)) data[el.name] = el.checked;
        });
        // Include the user's selection order so backend runs steps in this sequence
        data.step_order = selectionOrder.slice();
        return data;
    }

    // ---- Validate Workflow button ----

    btnValidateWf.addEventListener("click", function() {
        var path = photoDirInput.value.trim();

        // If folder not yet validated, do that first then show results
        if (path && !folderValid) {
            fetch("/api/validate_folder?path=" + encodeURIComponent(path))
                .then(function(res) { return res.json(); })
                .then(function(vdata) {
                    if (vdata.valid) {
                        folderValid = true;
                        photoDirInput.classList.remove("is-invalid");
                        photoDirInput.classList.add("is-valid");
                        if (vdata.warning) {
                            setFolderStatus(
                                '<i class="bi bi-exclamation-triangle-fill"></i> ' + vdata.warning,
                                "text-warning"
                            );
                        } else {
                            setFolderStatus(
                                '<i class="bi bi-check-circle-fill"></i> ' + vdata.photo_count + ' photo file'
                                + (vdata.photo_count !== 1 ? 's' : '') + ' found',
                                "text-success"
                            );
                        }
                    } else {
                        photoDirInput.classList.add("is-invalid");
                        setFolderStatus(
                            '<i class="bi bi-x-circle-fill"></i> ' + vdata.reason,
                            "text-danger"
                        );
                    }
                    showValidationWithPreflight();
                })
                .catch(function() {
                    setFolderStatus(
                        '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                        "text-danger"
                    );
                    showValidationWithPreflight();
                });
            return;
        }

        showValidationWithPreflight();
    });

    function showValidationWithPreflight(callback) {
        var v = validateWorkflow();
        var data = collectFormData();

        // Run preflight tool check and advisory checks in parallel
        var preflightDone = false;
        var advisoryDone = false;
        var advisories = [];

        function onBothDone() {
            if (!preflightDone || !advisoryDone) return;
            showValidationResult(v);
            showAdvisoryPanel(advisories);
            if (callback) callback(v);
        }

        // Preflight
        fetch("/api/preflight", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data)
        })
        .then(function(res) { return res.json(); })
        .then(function(pf) {
            if (!pf.ok) {
                v.valid = false;
                for (var i = 0; i < pf.missing.length; i++) {
                    var m = pf.missing[i];
                    v.errors.push(
                        "Missing tool: " + m.label
                        + " (needed by: " + m.needed_by.join(", ") + ")"
                    );
                }
            }
            if (pf.ok && pf.tools && Object.keys(pf.tools).length > 0) {
                var toolNames = [];
                for (var t in pf.tools) {
                    toolNames.push(pf.tools[t].resolved);
                }
                v.toolsOk = toolNames;
            }
            preflightDone = true;
            onBothDone();
        })
        .catch(function() {
            v.warnings.push("Could not run tool preflight check.");
            preflightDone = true;
            onBothDone();
        });

        // Advisory checks (non-blocking, informational)
        fetch("/api/advisory", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data)
        })
        .then(function(res) { return res.json(); })
        .then(function(result) {
            advisories = result;
            advisoryDone = true;
            onBothDone();
        })
        .catch(function() {
            advisoryDone = true;
            onBothDone();
        });
    }

    function showAdvisoryPanel(advisories) {
        if (!advisories || advisories.length === 0) {
            advisoryPanel.style.display = "none";
            advisoryPanel.innerHTML = "";
            return;
        }

        var html = '<div class="adv-header">'
            + '<i class="bi bi-clipboard-pulse"></i> '
            + advisories.length + ' advisory '
            + (advisories.length === 1 ? 'note' : 'notes')
            + '</div>';

        for (var i = 0; i < advisories.length; i++) {
            var adv = advisories[i];
            var cls = adv.level === "warning" ? "adv-warn" : "adv-info";
            html += '<div class="adv-item ' + cls + '">';
            html += '<i class="bi ' + adv.icon + '"></i> ';
            html += '<strong>' + adv.title + '</strong>';
            html += '<div class="adv-detail">' + adv.detail + '</div>';
            html += '</div>';
        }

        advisoryPanel.innerHTML = html;
        advisoryPanel.style.display = "block";
    }

    function showValidationResult(v) {
        var html = "";
        var cls = "vr-pass";

        if (v.errors.length > 0) {
            cls = "vr-fail";
            for (var i = 0; i < v.errors.length; i++) {
                html += '<div class="vr-item vr-error"><i class="bi bi-x-circle" style="font-size:.75rem"></i> ' + v.errors[i] + '</div>';
            }
        }

        if (v.warnings.length > 0) {
            if (cls !== "vr-fail") cls = "vr-fail";
            for (var j = 0; j < v.warnings.length; j++) {
                html += '<div class="vr-item vr-warning"><i class="bi bi-exclamation-triangle" style="font-size:.75rem"></i> ' + v.warnings[j] + '</div>';
            }
        }

        if (v.errors.length === 0 && v.warnings.length === 0) {
            var msg = "Workflow is valid. Folder, steps, and ordering all check out.";
            if (v.toolsOk && v.toolsOk.length > 0) {
                msg += " Tools verified: " + v.toolsOk.join(", ") + ".";
            }
            html = '<div class="vr-item vr-ok"><i class="bi bi-check-circle" style="font-size:.75rem"></i> ' + msg + '</div>';
        }

        validationResult.innerHTML = html;
        validationResult.className = "validation-result " + cls;
        validationResult.style.display = "block";

        // Auto-hide after 10 seconds if all good
        if (v.valid && v.warnings.length === 0) {
            setTimeout(function() {
                validationResult.style.display = "none";
            }, 10000);
        }
    }

    // ---- Run pipeline ----

    btnRun.addEventListener("click", function() {
        var data = collectFormData();

        // If folder hasn't been validated yet, do it first then re-check
        if (data.photo_dir && !folderValid) {
            fetch("/api/validate_folder?path=" + encodeURIComponent(data.photo_dir))
                .then(function(res) { return res.json(); })
                .then(function(vdata) {
                    if (vdata.valid) {
                        folderValid = true;
                        photoDirInput.classList.remove("is-invalid");
                        photoDirInput.classList.add("is-valid");
                        if (vdata.warning) {
                            setFolderStatus(
                                '<i class="bi bi-exclamation-triangle-fill"></i> ' + vdata.warning,
                                "text-warning"
                            );
                        } else {
                            setFolderStatus(
                                '<i class="bi bi-check-circle-fill"></i> ' + vdata.photo_count + ' photo file'
                                + (vdata.photo_count !== 1 ? 's' : '') + ' found',
                                "text-success"
                            );
                        }
                    } else {
                        photoDirInput.classList.add("is-invalid");
                        setFolderStatus(
                            '<i class="bi bi-x-circle-fill"></i> ' + vdata.reason,
                            "text-danger"
                        );
                    }
                    // Now run the full validation
                    runWithValidation();
                })
                .catch(function() {
                    setFolderStatus(
                        '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                        "text-danger"
                    );
                });
            return;
        }

        runWithValidation();
    });

    function runWithValidation() {
        showValidationWithPreflight(function(v) {
            // Hard errors: block execution
            if (!v.valid) {
                showPreRunDialog(v.errors, [], false);
                return;
            }

            // Warnings: show confirmation
            if (v.warnings.length > 0) {
                showPreRunDialog([], v.warnings, true);
                return;
            }

            // All clear
            startPipeline(collectFormData());
        });
    }

    function showPreRunDialog(errors, warnings, allowProceed) {
        var lines = [];

        if (errors.length > 0) {
            lines.push("CANNOT RUN:");
            for (var i = 0; i < errors.length; i++) {
                lines.push("  - " + errors[i]);
            }
        }

        if (warnings.length > 0) {
            if (lines.length > 0) lines.push("");
            lines.push("WARNINGS:");
            for (var j = 0; j < warnings.length; j++) {
                lines.push("  - " + warnings[j]);
            }
        }

        if (allowProceed) {
            lines.push("");
            lines.push("Proceed anyway?");
            if (confirm(lines.join("\n"))) {
                startPipeline(collectFormData());
            }
        } else {
            alert(lines.join("\n"));
        }
    }

    // Track pipeline step labels for strip visualization
    var pipelineStepLabels = [];

    function startPipeline(data) {
        btnRun.disabled = true;
        btnCancel.style.display = "inline-flex";
        logPanel.classList.add("active");
        progressBar.classList.add("active");

        // Scroll log panel into view so it's immediately visible
        setTimeout(function() {
            logPanel.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);

        // Reset log state
        logOffset = 0;
        logLineCount = 0;
        logAutoScroll = true;
        logPanel.innerHTML = "";

        // Show header with override notice if applicable
        var header = "Starting pipeline...\n";
        if (orderOverride) {
            header += "NOTE: Running with user-overridden step order.\n";
        }
        appendLogLines(header);

        // Project mode: include subfolder paths if the current folder has subfolders
        if (detectedSubfolders.length > 0) {
            data.project_folders = detectedSubfolders.map(function(f) { return f.path; });
            appendLogLines("Project mode: " + detectedSubfolders.length + " subfolders\n");
        }

        fetch("/api/run", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data),
        })
        .then(function(res) { return res.json(); })
        .then(function(body) {
            if (body.error) {
                logPanel.innerHTML = "";
                appendLogLines("Error: " + body.error + "\n");
                btnRun.disabled = false;
                btnCancel.style.display = "none";
                return;
            }
            currentJobId = body.job_id;
            pipelineStepLabels = body.steps || [];
            renderStepBadges(body.steps);
            // Initialize pipeline strip
            if (pipelineStepLabels.length > 0) {
                updatePipelineStrip(pipelineStepLabels, 0, "running");
            }
            startPolling();
        })
        .catch(function(err) {
            logPanel.innerHTML = "";
            appendLogLines("Request failed: " + err + "\n");
            btnRun.disabled = false;
            btnCancel.style.display = "none";
        });
    }

    // ---- Cancel ----

    btnCancel.addEventListener("click", function() {
        if (!currentJobId) return;
        fetch("/api/cancel/" + currentJobId, {method: "POST"});
    });

    // ---- Polling ----

    function startPolling() {
        pollTimer = setInterval(function() {
            if (!currentJobId) return;
            fetch("/api/log/" + currentJobId + "?offset=" + logOffset)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    if (data.log) {
                        appendLogLines(data.log);
                        logOffset = data.offset;
                    }

                    // Update step badges with status info
                    updateStepBadges({
                        status: data.status,
                        current_step: data.current_step,
                    });

                    // Update pipeline strip
                    if (pipelineStepLabels.length > 0) {
                        updatePipelineStrip(pipelineStepLabels, data.current_step || 0, data.status);
                    }

                    if (data.status !== "running") {
                        clearInterval(pollTimer);
                        btnRun.disabled = false;
                        btnCancel.style.display = "none";
                        currentJobId = null;
                        // Play completion sound
                        if (data.status === "done") playSuccessSound();
                        else if (data.status === "failed" || data.status === "cancelled") playErrorSound();
                        // Re-check blur/undo availability after pipeline completes
                        if (lastResolvedPath) {
                            checkBlurResultsAvailable(lastResolvedPath);
                            checkUndoAvailable(lastResolvedPath);
                        }
                    }
                })
                .catch(function() { /* ignore transient errors */ });
        }, 1000);
    }

    // ---- Log formatting ----

    function appendLogLines(text) {
        if (!text) return;
        var lines = text.split("\n");
        // If text ends with newline, remove trailing empty string
        if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
        }
        var frag = document.createDocumentFragment();
        for (var i = 0; i < lines.length; i++) {
            logLineCount++;
            var line = lines[i];
            var div = document.createElement("div");
            div.className = "log-line";

            // Detect step headers
            if (/^\[Step \d+\]/.test(line) || /^={10,}$/.test(line)) {
                div.className += " log-step-header";
            }

            var numSpan = document.createElement("span");
            numSpan.className = "log-line-num";
            numSpan.textContent = logLineCount;

            var textSpan = document.createElement("span");
            textSpan.className = "log-line-text";
            textSpan.textContent = line;

            div.appendChild(numSpan);
            div.appendChild(textSpan);
            frag.appendChild(div);
        }

        // Remove scroll lock indicator if present before appending
        var lockEl = logPanel.querySelector(".log-scroll-lock");
        if (lockEl) lockEl.remove();

        logPanel.appendChild(frag);

        // Re-add scroll lock indicator if not auto-scrolling
        if (!logAutoScroll) {
            showScrollLockIndicator();
        }

        if (logAutoScroll) {
            logPanel.scrollTop = logPanel.scrollHeight;
        }
    }

    function showScrollLockIndicator() {
        if (logPanel.querySelector(".log-scroll-lock")) return;
        var lockDiv = document.createElement("div");
        lockDiv.className = "log-scroll-lock";
        var badge = document.createElement("span");
        badge.className = "log-scroll-lock-badge";
        badge.textContent = "\u2193 Scroll locked \u2014 click to resume";
        badge.addEventListener("click", function() {
            logAutoScroll = true;
            logPanel.scrollTop = logPanel.scrollHeight;
            lockDiv.remove();
        });
        lockDiv.appendChild(badge);
        logPanel.appendChild(lockDiv);
    }

    // Detect user scrolling up in log panel
    logPanel.addEventListener("scroll", function() {
        var atBottom = logPanel.scrollHeight - logPanel.scrollTop - logPanel.clientHeight < 30;
        logAutoScroll = atBottom;
        if (atBottom) {
            var lockEl = logPanel.querySelector(".log-scroll-lock");
            if (lockEl) lockEl.remove();
        }
    });

    // ---- Step badges ----

    function renderStepBadges(steps) {
        stepsContainer.innerHTML = "";
        steps.forEach(function(label, i) {
            var span = document.createElement("span");
            span.className = "pipeline-step";
            span.textContent = label;
            span.dataset.index = i;
            stepsContainer.appendChild(span);
        });
    }

    function updateStepBadges(data) {
        var badges = stepsContainer.querySelectorAll(".pipeline-step");
        badges.forEach(function(badge, i) {
            badge.classList.remove("running", "done", "failed");
            if (data.status === "done") {
                badge.classList.add("done");
            } else if (data.status === "failed" || data.status === "cancelled") {
                if (i < data.current_step)       badge.classList.add("done");
                else if (i === data.current_step) badge.classList.add("failed");
            } else {
                if (i < data.current_step)       badge.classList.add("done");
                else if (i === data.current_step) badge.classList.add("running");
            }
        });
    }

    // ---- Standalone Search EXIF / IPTC ----

    var btnSearch       = document.getElementById("btn-search");
    var btnSearchCancel = document.getElementById("btn-search-cancel");
    var searchLog       = document.getElementById("search-log");
    var searchDirInput  = document.getElementById("search-dir");
    var searchQueryInput = document.getElementById("search-query");
    var searchJobId     = null;
    var searchPollTimer = null;

    // Wire up the docs link in the search panel
    var searchDocsLink = document.querySelector(".search-docs-link");
    if (searchDocsLink) {
        searchDocsLink.addEventListener("click", function(e) {
            e.stopPropagation();
            openDocsModal(searchDocsLink.dataset.doc);
        });
    }

    var _textSearchStartTime = 0;
    var _textSearchTimer = null;

    function launchTextSearch() {
        var dir = searchDirInput.value.trim() || photoDirInput.value.trim();
        var query = searchQueryInput.value.trim();

        if (!dir) {
            alert("Please specify a directory to search in.");
            return;
        }
        if (!query) {
            alert("Please enter a search query.");
            return;
        }

        var payload = {
            photo_dir: dir,
            search_query: query,
            search_fields: document.getElementById("search-fields").value,
            search_media_types: document.getElementById("search-media-types").value,
            search_recursive: document.getElementById("search-recursive").checked,
            search_fzf: document.getElementById("search-fzf").checked,
            search_copy_to: document.getElementById("search-copy-to").value.trim()
        };

        btnSearch.disabled = true;
        btnSearchCancel.style.display = "inline-block";
        textSearchResultsEl.style.display = "none";
        textSearchResultsEl.innerHTML = "";
        searchLog.style.display = "block";
        searchLog.classList.add("active");
        searchLog.textContent = "Searching in " + dir + " ...\n";

        _textSearchStartTime = Date.now();
        clearInterval(_textSearchTimer);
        _textSearchTimer = setInterval(function() {
            var secs = ((Date.now() - _textSearchStartTime) / 1000).toFixed(0);
            btnSearch.textContent = "Searching... (" + secs + "s)";
        }, 1000);
        btnSearch.innerHTML = '<i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> Searching... (0s)';

        fetch("/api/search", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        })
        .then(function(res) { return res.json(); })
        .then(function(body) {
            if (body.error) {
                searchLog.textContent = "Error: " + body.error;
                btnSearch.disabled = false;
                btnSearch.innerHTML = '<i class="bi bi-search"></i> Search';
                clearInterval(_textSearchTimer);
                btnSearchCancel.style.display = "none";
                return;
            }
            searchJobId = body.job_id;
            startSearchPolling();
        })
        .catch(function(err) {
            searchLog.textContent = "Request failed: " + err;
            btnSearch.disabled = false;
            btnSearch.innerHTML = '<i class="bi bi-search"></i> Search';
            clearInterval(_textSearchTimer);
            btnSearchCancel.style.display = "none";
        });
    }

    btnSearch.addEventListener("click", launchTextSearch);

    searchQueryInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            launchTextSearch();
        }
    });

    btnSearchCancel.addEventListener("click", function() {
        if (!searchJobId) return;
        fetch("/api/cancel/" + searchJobId, {method: "POST"});
    });

    var searchResultsEl = document.getElementById("search-results");
    var textSearchResultsEl = document.getElementById("text-search-results");

    function startSearchPolling() {
        searchPollTimer = setInterval(function() {
            if (!searchJobId) return;
            fetch("/api/status/" + searchJobId)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    searchLog.textContent = data.log;
                    searchLog.scrollTop = searchLog.scrollHeight;
                    if (data.status !== "running") {
                        clearInterval(searchPollTimer);
                        clearInterval(_textSearchTimer);
                        btnSearch.disabled = false;
                        btnSearch.innerHTML = '<i class="bi bi-search"></i> Search';
                        btnSearchCancel.style.display = "none";
                        searchJobId = null;
                        // Parse matched files from the log and fetch thumbnails
                        if (data.status === "done") {
                            renderSearchResults(data.log);
                        }
                    }
                })
                .catch(function() { /* ignore transient errors */ });
        }, 1000);
    }

    function renderSearchResults(log) {
        // Extract the resolved search directory from the log header
        // (the server normalizes it, e.g. C:\... -> /mnt/c/... on WSL)
        var dirMatch = log.match(/^Search directory:\s*(.+)$/m);
        var searchDir = dirMatch ? dirMatch[1].trim() : (searchDirInput.value.trim() || photoDirInput.value.trim());

        // Extract file paths from search output lines like "File: ./relative/path.jpg"
        var fileRegex = /^File:\s*(.+)$/gm;
        var match;
        var files = [];
        while ((match = fileRegex.exec(log)) !== null) {
            var f = match[1].trim();
            if (!f) continue;
            // Convert relative paths to absolute by prepending the resolved search dir
            if (f.startsWith("./")) {
                f = searchDir + "/" + f.substring(2);
            } else if (!f.startsWith("/") && !f.match(/^[A-Za-z]:/)) {
                f = searchDir + "/" + f;
            }
            files.push(f);
        }

        if (files.length === 0) {
            textSearchResultsEl.style.display = "none";
            return;
        }

        // Show loading state
        textSearchResultsEl.style.display = "block";
        textSearchResultsEl.innerHTML = '<div class="search-results-header">'
            + '<span><i class="bi bi-images"></i> ' + files.length + ' match' + (files.length !== 1 ? 'es' : '') + ' found</span>'
            + '<span class="text-muted">Loading metadata...</span></div>';

        // Fetch metadata for matched files
        fetch("/api/search_meta", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({files: files})
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            var results = data.results || [];
            var html = '<div class="search-results-header">'
                + '<span><i class="bi bi-images"></i> ' + results.length + ' match' + (results.length !== 1 ? 'es' : '') + '</span></div>';

            // Build a lookup by file path for metadata
            var metaMap = {};
            results.forEach(function(r) { metaMap[r.file] = r; });

            // Store metadata for modal use
            window._searchMetaMap = metaMap;
            window._searchFiles = files;

            // Render grid — use original file order
            html += '<div class="search-results-grid">';
            files.forEach(function(filepath, idx) {
                var m = metaMap[filepath] || {filename: filepath.split("/").pop(), comment: "", caption: "", keywords: ""};
                var thumbUrl = "/api/thumbnail?path=" + encodeURIComponent(filepath) + "&size=200";

                html += '<div class="search-result-card">';
                html += '<a href="#" class="photo-preview-link" data-idx="' + idx + '">';
                html += '<img src="' + thumbUrl + '" alt="' + escapeHtml(m.filename) + '" loading="lazy">';
                html += '</a>';
                html += '<div class="search-result-meta">';
                html += '<div class="search-result-filename" title="' + escapeHtml(filepath) + '">' + escapeHtml(m.filename) + '</div>';
                if (m.caption) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Caption:</span> ' + escapeHtml(m.caption) + '</div>';
                }
                if (m.comment) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Comment:</span> ' + escapeHtml(m.comment) + '</div>';
                }
                if (m.keywords) {
                    html += '<div class="search-result-field"><span class="search-result-field-label">Keywords:</span> ' + escapeHtml(m.keywords) + '</div>';
                }
                html += '</div></div>';
            });
            html += '</div>';

            textSearchResultsEl.innerHTML = html;
            wireTextSearchPreviewLinks();
        })
        .catch(function() {
            // Fallback: show thumbnails without metadata
            window._searchMetaMap = {};
            window._searchFiles = files;
            var html = '<div class="search-results-header">'
                + '<span><i class="bi bi-images"></i> ' + files.length + ' matches</span></div>';
            html += '<div class="search-results-grid">';
            files.forEach(function(filepath, idx) {
                var fname = filepath.split("/").pop();
                var thumbUrl = "/api/thumbnail?path=" + encodeURIComponent(filepath) + "&size=200";
                html += '<div class="search-result-card">';
                html += '<a href="#" class="photo-preview-link" data-idx="' + idx + '"><img src="' + thumbUrl + '" alt="' + escapeHtml(fname) + '" loading="lazy"></a>';
                html += '<div class="search-result-meta"><div class="search-result-filename">' + escapeHtml(fname) + '</div></div>';
                html += '</div>';
            });
            html += '</div>';
            textSearchResultsEl.innerHTML = html;
            wireTextSearchPreviewLinks();
        });
    }

    // ---- Structured Search ----

    var btnDiscoverFields      = document.getElementById("btn-discover-fields");
    var discoverStatus         = document.getElementById("discover-status");
    var structuredFieldsEl     = document.getElementById("structured-fields");
    var exifFilterList         = document.getElementById("exif-filter-list");
    var iptcFilterList         = document.getElementById("iptc-filter-list");
    var addFieldSelect         = document.getElementById("add-field-select");
    var btnStructuredSearch    = document.getElementById("btn-structured-search");
    var structuredSearchStatus = document.getElementById("structured-search-status");
    var structuredResultsHeader = document.getElementById("structured-results-header");

    // Full schema stored after discover
    var _discoveredSchema = null;

    // Track active filter field names to avoid duplicates
    var _activeFilters = {};

    if (btnDiscoverFields) {
        btnDiscoverFields.addEventListener("click", function() {
            discoverFields();
        });
    }

    if (btnStructuredSearch) {
        btnStructuredSearch.addEventListener("click", function() {
            runStructuredSearch();
        });
    }

    // Enter key in any structured search input triggers search
    var structuredFieldsEl = document.getElementById("structured-fields");
    if (structuredFieldsEl) {
        structuredFieldsEl.addEventListener("keydown", function(e) {
            if (e.key === "Enter") {
                e.preventDefault();
                runStructuredSearch();
            }
        });
    }

    if (addFieldSelect) {
        addFieldSelect.addEventListener("change", function() {
            var val = addFieldSelect.value;
            if (!val || !_discoveredSchema) return;

            // Find the field in the schema
            var allFields = (_discoveredSchema.exif_fields || []).concat(_discoveredSchema.iptc_fields || []);
            var field = null;
            var group = null;
            for (var i = 0; i < allFields.length; i++) {
                if (allFields[i].name === val) {
                    field = allFields[i];
                    // Determine group
                    var isIptc = false;
                    for (var j = 0; j < (_discoveredSchema.iptc_fields || []).length; j++) {
                        if (_discoveredSchema.iptc_fields[j].name === val) { isIptc = true; break; }
                    }
                    group = isIptc ? "IPTC" : "EXIF";
                    break;
                }
            }

            if (field) {
                var targetList = group === "IPTC" ? iptcFilterList : exifFilterList;
                var row = renderFilterRow(field, group);
                targetList.appendChild(row);
                _activeFilters[val] = true;
                refreshAddFieldDropdown();
            }

            addFieldSelect.value = "";
        });
    }

    function discoverFields() {
        var dir = searchDirInput.value.trim() || photoDirInput.value.trim();
        if (!dir) {
            discoverStatus.innerHTML = '<span style="color:var(--ps-danger)">Please specify a directory first.</span>';
            return;
        }

        var recursive = document.getElementById("search-recursive").checked;
        btnDiscoverFields.disabled = true;

        // Show progress indicator with elapsed timer
        var startTime = Date.now();
        var progressTimer = null;
        function updateProgress(msg) {
            var elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            discoverStatus.innerHTML = '<span class="text-muted">'
                + '<i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> '
                + msg + ' (' + elapsed + 's)</span>';
        }

        // Single-phase discovery — the endpoint handles counting, auto-recursion, and sampling
        var scanMsg = recursive ? "Scanning folder tree for photos..." : "Scanning folder for photos...";
        updateProgress(scanMsg);
        progressTimer = setInterval(function() { updateProgress(scanMsg); }, 1000);

        var url = "/api/search/discover?path=" + encodeURIComponent(dir)
                + "&recursive=" + (recursive ? "1" : "0");
        fetch(url)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (progressTimer) clearInterval(progressTimer);
                btnDiscoverFields.disabled = false;

                if (data.error) {
                    discoverStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(data.error) + '</span>';
                    return;
                }

                _discoveredSchema = data;

                // Clear existing filter rows
                exifFilterList.innerHTML = "";
                iptcFilterList.innerHTML = "";
                _activeFilters = {};

                // Populate default fields
                var defaultFields = data.default_fields || [];
                var allExif = data.exif_fields || [];
                var allIptc = data.iptc_fields || [];

                defaultFields.forEach(function(dfName) {
                    // Find in EXIF first, then IPTC
                    var field = null;
                    var group = "EXIF";
                    for (var i = 0; i < allExif.length; i++) {
                        if (allExif[i].name === dfName) { field = allExif[i]; break; }
                    }
                    if (!field) {
                        for (var j = 0; j < allIptc.length; j++) {
                            if (allIptc[j].name === dfName) { field = allIptc[j]; group = "IPTC"; break; }
                        }
                    }
                    if (field) {
                        var targetList = group === "IPTC" ? iptcFilterList : exifFilterList;
                        var row = renderFilterRow(field, group);
                        targetList.appendChild(row);
                        _activeFilters[dfName] = true;
                    }
                });

                // Show the structured fields area
                structuredFieldsEl.style.display = "block";

                // Populate add-field dropdown
                refreshAddFieldDropdown();

                var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                var statusMsg = '<span style="color:var(--ps-success)"><i class="bi bi-check-circle"></i> '
                    + 'Sampled ' + (data.sampled || 0) + ' of ' + (data.total || 0) + ' files'
                    + ' in ' + elapsed + 's';
                if (data.auto_recursive) {
                    statusMsg += '</span> <span style="color:var(--ps-warning)"><i class="bi bi-exclamation-triangle"></i> '
                        + 'No photos in top folder — scanned subfolders';
                    // Auto-check the recursive checkbox so the search also recurses
                    var recCheckbox = document.getElementById("search-recursive");
                    if (recCheckbox && !recCheckbox.checked) recCheckbox.checked = true;
                }
                statusMsg += '</span>';
                discoverStatus.innerHTML = statusMsg;
            })
            .catch(function(err) {
                if (progressTimer) clearInterval(progressTimer);
                btnDiscoverFields.disabled = false;
                discoverStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(String(err)) + '</span>';
            });
    }

    function renderFilterRow(field, group) {
        var filterMode = field.filter_mode || "";  // "regex", "keywords_all", "select", or ""
        var row = document.createElement("div");
        row.className = "structured-filter-row";
        row.dataset.fieldName = field.field || field.name;  // column name for catalog, exiftool name for structured
        row.dataset.fieldGroup = group;
        row.dataset.fieldType = field.type;
        row.dataset.filterMode = filterMode;

        var nameSpan = document.createElement("span");
        nameSpan.className = "filter-name";
        nameSpan.textContent = field.name;
        row.appendChild(nameSpan);

        var inputsDiv = document.createElement("div");
        inputsDiv.className = "filter-inputs";

        // Special filter modes override the default type-based rendering
        if (filterMode === "regex") {
            var regexInput = document.createElement("input");
            regexInput.type = "text";
            regexInput.className = "form-control form-control-sm";
            regexInput.placeholder = "regex pattern (e.g. IMG_\\d{4})";
            regexInput.dataset.role = "value";
            regexInput.style.maxWidth = "300px";
            inputsDiv.appendChild(regexInput);
            var regexHint = document.createElement("span");
            regexHint.className = "range-sep";
            regexHint.textContent = "regex";
            regexHint.style.fontSize = "9px";
            regexHint.style.opacity = "0.6";
            inputsDiv.appendChild(regexHint);

        } else if (filterMode === "keywords_all") {
            var kwInput = document.createElement("input");
            kwInput.type = "text";
            kwInput.className = "form-control form-control-sm";
            kwInput.placeholder = "space-separated terms (all must match)";
            kwInput.dataset.role = "value";
            kwInput.style.maxWidth = "300px";
            inputsDiv.appendChild(kwInput);
            var kwHint = document.createElement("span");
            kwHint.className = "range-sep";
            kwHint.textContent = "all match, regex";
            kwHint.style.fontSize = "9px";
            kwHint.style.opacity = "0.6";
            inputsDiv.appendChild(kwHint);

        } else if (field.type === "numeric") {
            var minInput = document.createElement("input");
            minInput.type = "number";
            minInput.className = "form-control form-control-sm";
            minInput.placeholder = field.min != null ? String(field.min) : "min";
            minInput.dataset.role = "min";
            if (field.min != null) minInput.title = "Min observed: " + field.min;
            inputsDiv.appendChild(minInput);

            var sep = document.createElement("span");
            sep.className = "range-sep";
            sep.textContent = "\u2014";
            inputsDiv.appendChild(sep);

            var maxInput = document.createElement("input");
            maxInput.type = "number";
            maxInput.className = "form-control form-control-sm";
            maxInput.placeholder = field.max != null ? String(field.max) : "max";
            maxInput.dataset.role = "max";
            if (field.max != null) maxInput.title = "Max observed: " + field.max;
            inputsDiv.appendChild(maxInput);

        } else if (field.type === "date") {
            var minDate = document.createElement("input");
            minDate.type = "date";
            minDate.className = "form-control form-control-sm";
            minDate.dataset.role = "min";
            if (field.min) minDate.title = "Earliest: " + field.min;
            inputsDiv.appendChild(minDate);

            var dateSep = document.createElement("span");
            dateSep.className = "range-sep";
            dateSep.textContent = "\u2014";
            inputsDiv.appendChild(dateSep);

            var maxDate = document.createElement("input");
            maxDate.type = "date";
            maxDate.className = "form-control form-control-sm";
            maxDate.dataset.role = "max";
            if (field.max) maxDate.title = "Latest: " + field.max;
            inputsDiv.appendChild(maxDate);

        } else if (field.type === "select" && field.values && field.values.length > 0) {
            var cbGroup = document.createElement("div");
            cbGroup.className = "filter-checkbox-group";
            cbGroup.dataset.role = "values";
            field.values.forEach(function(v) {
                var lbl = document.createElement("label");
                lbl.className = "filter-checkbox-item";
                var cb = document.createElement("input");
                cb.type = "checkbox";
                cb.value = v;
                cb.className = "form-check-input";
                lbl.appendChild(cb);
                lbl.appendChild(document.createTextNode(" " + v));
                cbGroup.appendChild(lbl);
            });
            inputsDiv.appendChild(cbGroup);

        } else {
            // text type
            var textInput = document.createElement("input");
            textInput.type = "text";
            textInput.className = "form-control form-control-sm";
            textInput.placeholder = field.sample ? "e.g. " + field.sample : "contains...";
            textInput.dataset.role = "value";
            textInput.style.maxWidth = "300px";
            inputsDiv.appendChild(textInput);
        }

        row.appendChild(inputsDiv);

        var removeBtn = document.createElement("button");
        removeBtn.className = "filter-remove";
        removeBtn.title = "Remove filter";
        removeBtn.innerHTML = '<i class="bi bi-x"></i>';
        removeBtn.addEventListener("click", function() {
            row.parentNode.removeChild(row);
            delete _activeFilters[field.name];
            refreshAddFieldDropdown();
        });
        row.appendChild(removeBtn);

        return row;
    }

    function refreshAddFieldDropdown() {
        if (!addFieldSelect || !_discoveredSchema) return;

        // Clear existing options
        addFieldSelect.innerHTML = '<option value="">+ Add field...</option>';

        var allExif = _discoveredSchema.exif_fields || [];
        var allIptc = _discoveredSchema.iptc_fields || [];

        if (allExif.length > 0) {
            var exifGroup = document.createElement("optgroup");
            exifGroup.label = "EXIF";
            allExif.forEach(function(f) {
                if (!_activeFilters[f.name]) {
                    var opt = document.createElement("option");
                    opt.value = f.name;
                    opt.textContent = f.name;
                    exifGroup.appendChild(opt);
                }
            });
            if (exifGroup.children.length > 0) {
                addFieldSelect.appendChild(exifGroup);
            }
        }

        if (allIptc.length > 0) {
            var iptcGroup = document.createElement("optgroup");
            iptcGroup.label = "IPTC";
            allIptc.forEach(function(f) {
                if (!_activeFilters[f.name]) {
                    var opt = document.createElement("option");
                    opt.value = f.name;
                    opt.textContent = f.name;
                    iptcGroup.appendChild(opt);
                }
            });
            if (iptcGroup.children.length > 0) {
                addFieldSelect.appendChild(iptcGroup);
            }
        }
    }

    function collectStructuredFilters() {
        var filters = [];
        // Only collect from the Structured tab's filter lists (not Catalog tab)
        var container = document.getElementById("structured-fields");
        if (!container) return filters;
        var rows = container.querySelectorAll(".structured-filter-row");
        rows.forEach(function(row) {
            var fieldName = row.dataset.fieldName;
            var fieldType = row.dataset.fieldType;
            var filterMode = row.dataset.filterMode || "";

            // Special filter modes override type-based collection
            if (filterMode === "regex" || filterMode === "keywords_all") {
                var valEl = row.querySelector('[data-role="value"]');
                var val = valEl ? valEl.value.trim() : "";
                if (val) {
                    filters.push({field: fieldName, op: filterMode, value: val});
                }

            } else if (fieldType === "numeric" || fieldType === "date") {
                var minEl = row.querySelector('[data-role="min"]');
                var maxEl = row.querySelector('[data-role="max"]');
                var minVal = minEl ? minEl.value.trim() : "";
                var maxVal = maxEl ? maxEl.value.trim() : "";

                if (minVal || maxVal) {
                    var filter = {field: fieldName, op: "range"};
                    if (minVal) filter.min = fieldType === "numeric" ? parseFloat(minVal) : minVal;
                    if (maxVal) filter.max = fieldType === "numeric" ? parseFloat(maxVal) : maxVal;
                    filters.push(filter);
                }

            } else if (fieldType === "select") {
                var cbGroup = row.querySelector('[data-role="values"]');
                if (cbGroup) {
                    var selected = [];
                    cbGroup.querySelectorAll('input[type="checkbox"]:checked').forEach(function(cb) {
                        selected.push(cb.value);
                    });
                    if (selected.length > 0) {
                        filters.push({field: fieldName, op: "in", values: selected});
                    }
                }

            } else {
                // generic text — default to contains
                var txtEl = row.querySelector('[data-role="value"]');
                var txtVal = txtEl ? txtEl.value.trim() : "";
                if (txtVal) {
                    filters.push({field: fieldName, op: "contains", value: txtVal});
                }
            }
        });
        return filters;
    }

    var _structuredJobId = null;
    var _structuredPollTimer = null;
    var _structuredStartTime = null;
    var _structuredPerPage = 50;

    function runStructuredSearch() {
        var dir = searchDirInput.value.trim() || photoDirInput.value.trim();
        if (!dir) {
            structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)">Please specify a directory.</span>';
            return;
        }

        var filters = collectStructuredFilters();
        if (filters.length === 0) {
            structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)">Please set at least one filter value.</span>';
            return;
        }

        var recursive = document.getElementById("search-recursive").checked;

        btnStructuredSearch.disabled = true;
        searchResultsEl.style.display = "none";
        searchResultsEl.innerHTML = "";
        structuredResultsHeader.style.display = "none";
        _structuredStartTime = Date.now();
        _prefetchedPages = {};
        window._searchFiles = [];
        window._searchMetaMap = {};

        // Show cancel button
        var cancelBtn = document.getElementById("btn-structured-cancel");
        if (cancelBtn) cancelBtn.style.display = "";

        function updateSearchProgress() {
            var elapsed = ((Date.now() - _structuredStartTime) / 1000).toFixed(0);
            structuredSearchStatus.innerHTML = '<span class="text-muted">'
                + '<i class="bi bi-arrow-repeat" style="animation:spin 1s linear infinite"></i> '
                + 'Searching... (' + elapsed + 's)</span>';
        }
        updateSearchProgress();
        _structuredPollTimer = setInterval(updateSearchProgress, 1000);

        fetch("/api/search/structured", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ path: dir, recursive: recursive, filters: filters, logic: "AND" })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.error) {
                if (_structuredPollTimer) clearInterval(_structuredPollTimer);
                btnStructuredSearch.disabled = false;
                if (cancelBtn) cancelBtn.style.display = "none";
                structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(data.error) + '</span>';
                return;
            }
            _structuredJobId = data.job_id;
            pollStructuredSearch(1);
        })
        .catch(function(err) {
            if (_structuredPollTimer) clearInterval(_structuredPollTimer);
            btnStructuredSearch.disabled = false;
            if (cancelBtn) cancelBtn.style.display = "none";
            structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(String(err)) + '</span>';
        });
    }

    function pollStructuredSearch(page) {
        if (!_structuredJobId) return;
        fetch("/api/search/structured/status/" + _structuredJobId + "?page=" + page + "&per_page=" + _structuredPerPage)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.status === "running") {
                    setTimeout(function() { pollStructuredSearch(page); }, 1000);
                    return;
                }

                if (_structuredPollTimer) clearInterval(_structuredPollTimer);
                btnStructuredSearch.disabled = false;
                var cancelBtn = document.getElementById("btn-structured-cancel");
                if (cancelBtn) cancelBtn.style.display = "none";
                // Keep job_id for pagination — store separately
                searchResultsEl.dataset.jobId = _structuredJobId;
                _structuredJobId = null;

                if (data.status === "failed" || data.error) {
                    structuredSearchStatus.innerHTML = '<span style="color:var(--ps-danger)"><i class="bi bi-x-circle"></i> ' + escapeHtml(data.error || "Search failed") + '</span>';
                    return;
                }

                var elapsed = ((Date.now() - _structuredStartTime) / 1000).toFixed(1);
                var results = data.results || [];
                var totalMatches = data.matches || 0;
                var totalScanned = data.total_scanned || 0;
                var totalPages = data.total_pages || 1;
                var currentPage = data.page || 1;

                structuredSearchStatus.innerHTML = '';
                structuredResultsHeader.style.display = "block";
                var headerMsg = '<span><i class="bi bi-images"></i> '
                    + totalMatches.toLocaleString() + ' match' + (totalMatches !== 1 ? 'es' : '')
                    + ' of ' + totalScanned.toLocaleString() + ' scanned (' + elapsed + 's)</span>';
                if (totalPages > 1) {
                    headerMsg += ' <span class="text-muted" style="margin-left:8px">Page ' + currentPage + ' of ' + totalPages + '</span>';
                }
                structuredResultsHeader.innerHTML = headerMsg;

                if (results.length === 0 && currentPage === 1) {
                    searchResultsEl.style.display = "none";
                    return;
                }

                // Build file list and meta map for this page
                var files = [];
                var metaMap = {};
                results.forEach(function(r) { files.push(r.file); metaMap[r.file] = r; });
                window._searchFiles = files;
                window._searchMetaMap = metaMap;

                renderStructuredPage(files, metaMap, currentPage, totalPages);
            })
            .catch(function() {
                setTimeout(function() { pollStructuredSearch(page); }, 2000);
            });
    }

    var _prefetchedPages = {};  // page number -> true (already prefetched)

    function renderStructuredPage(files, metaMap, currentPage, totalPages) {
        var html = '<div class="search-results-grid">';
        files.forEach(function(filepath, idx) {
            var m = metaMap[filepath] || {filename: filepath.split("/").pop()};
            var thumbUrl = "/api/thumbnail?path=" + encodeURIComponent(filepath) + "&size=200";
            html += '<div class="search-result-card">';
            html += '<a href="#" class="photo-preview-link" data-idx="' + idx + '">';
            html += '<img src="' + thumbUrl + '" alt="' + escapeHtml(m.filename || "") + '" loading="eager">';
            html += '</a>';
            html += '<div class="search-result-meta">';
            html += '<div class="search-result-filename" title="' + escapeHtml(filepath) + '">' + escapeHtml(m.filename || "") + '</div>';
            if (m.caption) html += '<div class="search-result-field"><span class="search-result-field-label">Caption:</span> ' + escapeHtml(m.caption) + '</div>';
            if (m.comment) html += '<div class="search-result-field"><span class="search-result-field-label">Comment:</span> ' + escapeHtml(m.comment) + '</div>';
            if (m.keywords) html += '<div class="search-result-field"><span class="search-result-field-label">Keywords:</span> ' + escapeHtml(m.keywords) + '</div>';
            html += '</div></div>';
        });
        html += '</div>';

        if (totalPages > 1) {
            html += '<div class="d-flex justify-content-center gap-2 mt-3 align-items-center">';
            if (currentPage > 1)
                html += '<button class="btn btn-sm btn-photoshell structured-page-btn" data-page="' + (currentPage - 1) + '"><i class="bi bi-chevron-left"></i> Prev</button>';
            html += '<span class="text-muted" style="font-size:12px">Page ' + currentPage + ' of ' + totalPages + '</span>';
            if (currentPage < totalPages)
                html += '<button class="btn btn-sm btn-photoshell structured-page-btn" data-page="' + (currentPage + 1) + '">Next <i class="bi bi-chevron-right"></i></button>';
            html += '</div>';
        }

        searchResultsEl.innerHTML = html;
        searchResultsEl.style.display = "block";
        wirePhotoPreviewLinks();

        // Scroll the main container so the top of results is visible
        var appMain = document.querySelector(".app-main");
        if (appMain && searchResultsEl.offsetTop > 0) {
            appMain.scrollTop = searchResultsEl.offsetTop - 60;
        }

        searchResultsEl.querySelectorAll(".structured-page-btn").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var pg = parseInt(btn.dataset.page, 10);
                var storedJobId = searchResultsEl.dataset.jobId;
                if (!storedJobId) return;
                fetch("/api/search/structured/status/" + storedJobId + "?page=" + pg + "&per_page=" + _structuredPerPage)
                    .then(function(r) { return r.json(); })
                    .then(function(d) {
                        if (d.results) {
                            var f2 = [], m2 = {};
                            d.results.forEach(function(r) { f2.push(r.file); m2[r.file] = r; });
                            window._searchFiles = f2;
                            window._searchMetaMap = m2;
                            renderStructuredPage(f2, m2, d.page, d.total_pages);
                        }
                    });
            });
        });

        // Prefetch thumbnails for the next 3 pages
        _prefetchedPages[currentPage] = true;
        prefetchAheadPages(currentPage, totalPages);
    }

    function prefetchAheadPages(currentPage, totalPages) {
        var storedJobId = searchResultsEl.dataset.jobId;
        if (!storedJobId) return;

        var LOOKAHEAD = 3;
        for (var ahead = 1; ahead <= LOOKAHEAD; ahead++) {
            (function(pg) {
                if (pg > totalPages || _prefetchedPages[pg]) return;
                _prefetchedPages[pg] = true;

                fetch("/api/search/structured/status/" + storedJobId + "?page=" + pg + "&per_page=" + _structuredPerPage)
                    .then(function(r) { return r.json(); })
                    .then(function(d) {
                        if (!d.results) return;
                        // Preload each thumbnail into the browser cache
                        d.results.forEach(function(r) {
                            var img = new Image();
                            img.src = "/api/thumbnail?path=" + encodeURIComponent(r.file) + "&size=200";
                        });
                    })
                    .catch(function() {}); // silent — prefetch is best-effort
            })(currentPage + ahead);
        }
    }

    // Cancel structured search
    var btnStructuredCancel = document.getElementById("btn-structured-cancel");
    if (btnStructuredCancel) {
        btnStructuredCancel.addEventListener("click", function() {
            if (_structuredJobId) {
                fetch("/api/cancel/" + _structuredJobId, {method: "POST"});
                _structuredJobId = null;
            }
            if (_structuredPollTimer) clearInterval(_structuredPollTimer);
            btnStructuredSearch.disabled = false;
            btnStructuredCancel.style.display = "none";
            structuredSearchStatus.innerHTML = '<span style="color:var(--ps-warning)"><i class="bi bi-x-circle"></i> Cancelled</span>';
        });
    }

    // ---- Photo preview modal ----

    var photoPreviewModalEl = document.getElementById("photoPreviewModal");
    var photoPreviewModal = new bootstrap.Modal(photoPreviewModalEl);
    var photoPreviewImg = document.getElementById("photo-preview-img");
    var photoPreviewTitle = document.getElementById("photo-preview-title");
    var photoPreviewFooter = document.getElementById("photo-preview-footer");

    // Clear image when modal closes to prevent stale flash on next open
    photoPreviewModalEl.addEventListener("hidden.bs.modal", function() {
        photoPreviewImg.src = "";
        photoPreviewImg.style.display = "none";
    });

    function wirePhotoPreviewLinks() {
        searchResultsEl.querySelectorAll(".photo-preview-link").forEach(function(link) {
            link.addEventListener("click", function(e) {
                e.preventDefault();
                var idx = parseInt(link.dataset.idx, 10);
                openPhotoPreview(idx);
            });
        });
    }

    function wireTextSearchPreviewLinks() {
        textSearchResultsEl.querySelectorAll(".photo-preview-link").forEach(function(link) {
            link.addEventListener("click", function(e) {
                e.preventDefault();
                var idx = parseInt(link.dataset.idx, 10);
                openPhotoPreview(idx);
            });
        });
    }

    // Loading spinner element for preview modal
    var photoPreviewSpinner = document.createElement("div");
    photoPreviewSpinner.className = "preview-loading";
    photoPreviewSpinner.innerHTML = '<i class="bi bi-arrow-repeat" style="font-size:32px;animation:spin 1s linear infinite;color:var(--ps-accent)"></i>';
    photoPreviewImg.parentNode.insertBefore(photoPreviewSpinner, photoPreviewImg);

    function openPhotoPreview(idx) {
        var files = window._searchFiles || [];
        var metaMap = window._searchMetaMap || {};
        if (idx < 0 || idx >= files.length) return;

        var filepath = files[idx];
        var m = metaMap[filepath] || {filename: filepath.split("/").pop(), comment: "", caption: "", keywords: ""};
        var fullUrl = "/api/thumbnail?path=" + encodeURIComponent(filepath) + "&size=1600";

        photoPreviewTitle.textContent = m.filename;

        // Reset rotation
        _previewRotation = 0;
        photoPreviewImg.style.transform = "";

        // Store path for EXIF/IPTC/download buttons
        photoPreviewModalEl.dataset.currentPath = filepath;
        updateDownloadButton(filepath);

        // Hide old image and show spinner while new one loads
        photoPreviewImg.style.display = "none";
        photoPreviewSpinner.style.display = "flex";
        photoPreviewImg.alt = m.filename;

        // Create a new Image to preload — only swap when fully loaded
        var loader = new Image();
        loader.onload = function() {
            photoPreviewImg.src = loader.src;
            photoPreviewImg.style.display = "block";
            photoPreviewSpinner.style.display = "none";
        };
        loader.onerror = function() {
            photoPreviewImg.src = "";
            photoPreviewImg.style.display = "none";
            photoPreviewSpinner.innerHTML = '<i class="bi bi-x-circle" style="font-size:32px;color:var(--ps-danger)"></i>'
                + '<div style="color:var(--ps-text-muted);font-size:12px;margin-top:8px">Failed to load image</div>';
        };
        loader.src = fullUrl;

        // Build footer with metadata — full path first
        var footerHtml = '<div class="preview-meta-filepath">"' + escapeHtml(filepath) + '"</div>';
        if (m.caption) {
            footerHtml += '<div class="preview-meta-field"><span class="preview-meta-label">Caption</span>' + escapeHtml(m.caption) + '</div>';
        }
        if (m.comment) {
            footerHtml += '<div class="preview-meta-field"><span class="preview-meta-label">Summary</span>' + escapeHtml(m.comment) + '</div>';
        }
        if (m.keywords) {
            footerHtml += '<div class="preview-meta-field"><span class="preview-meta-label">Keywords</span>' + escapeHtml(m.keywords) + '</div>';
        }
        if (!m.caption && !m.comment && !m.keywords) {
            footerHtml += '<div class="preview-meta-field" style="color:var(--ps-text-dim)">No metadata available</div>';
        }
        photoPreviewFooter.innerHTML = footerHtml;

        photoPreviewModal.show();
    }

    // ---- Catalog ----

    var catalogStatus = document.getElementById("catalog-status");
    var catalogLog = document.getElementById("catalog-log");
    var catalogResults = document.getElementById("catalog-results");
    var catalogResultsGrid = document.getElementById("catalog-results-grid");
    var catalogResultsHeader = document.getElementById("catalog-results-header");
    var catalogResultsPagination = document.getElementById("catalog-results-pagination");
    var catalogSearchQuery = document.getElementById("catalog-search-query");
    var catalogJobId = null;
    var catalogPollTimer = null;
    var catalogCurrentPage = 1;

    function getCatalogDir() {
        return document.getElementById("search-dir").value.trim() || photoDirInput.value.trim();
    }

    function checkCatalogStatus() {
        var dir = getCatalogDir();
        if (!dir) {
            catalogStatus.textContent = "Enter a directory above to check for an existing catalog.";
            return;
        }
        catalogStatus.innerHTML = '<i class="bi bi-hourglass-split"></i> Checking catalog...';
        fetch("/api/catalog/status?path=" + encodeURIComponent(dir))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.exists && data.stats) {
                    var s = data.stats;
                    catalogStatus.innerHTML =
                        '<i class="bi bi-database-check" style="color:var(--ps-success)"></i> ' +
                        '<strong>' + s.total_files + '</strong> files indexed' +
                        ' | ' + s.camera_models + ' camera' + (s.camera_models !== 1 ? 's' : '') +
                        ' | GPS: ' + s.with_gps +
                        ' | Keywords: ' + s.with_keywords +
                        (s.earliest_date ? ' | ' + s.earliest_date.split(' ')[0] + ' \u2013 ' + s.latest_date.split(' ')[0] : '') +
                        ' <small style="color:var(--ps-text-dim)">(' + (s.db_size / 1024 / 1024).toFixed(1) + ' MB)</small>';
                } else {
                    catalogStatus.innerHTML =
                        '<i class="bi bi-database-x" style="color:var(--ps-text-dim)"></i> ' +
                        'No catalog found. Click <strong>Build</strong> to create one.';
                }
            })
            .catch(function() {
                catalogStatus.textContent = "Failed to check catalog status";
            });
    }

    // Check catalog status when the Catalog tab is shown
    document.getElementById("tab-catalog").addEventListener("shown.bs.tab", function() {
        checkCatalogStatus();
    });

    // Auto-validate directory and check catalog on paste/input in the shared search-dir field
    var catalogDirTimer = null;
    var searchDirInput = document.getElementById("search-dir");

    function onSearchDirChanged() {
        // Only act when the Catalog tab is active
        var catalogTabActive = document.getElementById("tab-catalog").classList.contains("active");
        if (!catalogTabActive) return;

        var dir = searchDirInput.value.trim();
        if (!dir) {
            catalogStatus.textContent = "Enter a directory above to check for an existing catalog.";
            return;
        }

        catalogStatus.innerHTML = '<i class="bi bi-hourglass-split"></i> Validating...';

        fetch("/api/validate_folder?path=" + encodeURIComponent(dir))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.valid) {
                    searchDirInput.classList.remove("is-invalid");
                    searchDirInput.classList.add("is-valid");
                    // Update the input with the resolved path if expanded
                    if (data.path && data.path !== dir) {
                        searchDirInput.value = data.path;
                    }
                    checkCatalogStatus();
                } else {
                    searchDirInput.classList.remove("is-valid");
                    searchDirInput.classList.add("is-invalid");
                    catalogStatus.innerHTML = '<i class="bi bi-x-circle" style="color:var(--ps-danger)"></i> ' + (data.reason || "Invalid directory");
                }
            })
            .catch(function() {
                catalogStatus.textContent = "Validation failed";
            });
    }

    searchDirInput.addEventListener("paste", function() {
        clearTimeout(catalogDirTimer);
        setTimeout(onSearchDirChanged, 50);
    });

    searchDirInput.addEventListener("input", function() {
        clearTimeout(catalogDirTimer);
        catalogDirTimer = setTimeout(onSearchDirChanged, 600);
    });

    function startCatalogJob(mode, excludeDirs) {
        var dir = getCatalogDir();
        if (!dir) { alert("Enter a directory first."); return; }

        var body = {
            path: dir,
            mode: mode,
            file_types: document.getElementById("catalog-file-types").value.trim(),
            depth: parseInt(document.getElementById("catalog-depth").value) || 0,
            file_pattern: document.getElementById("catalog-file-pattern").value.trim(),
            folder_pattern: document.getElementById("catalog-folder-pattern").value.trim(),
        };
        if (excludeDirs && excludeDirs.length > 0) {
            body.exclude_dirs = excludeDirs;
        }

        catalogLog.textContent = "Starting catalog " + mode + "...\n";
        catalogLog.style.display = "block";
        document.getElementById("catalog-progress").style.display = "block";
        document.getElementById("catalog-progress-bar").style.width = "0%";
        document.getElementById("catalog-progress-pct").textContent = "0%";
        document.getElementById("catalog-progress-text").textContent = "Starting...";

        fetch("/api/catalog/build", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body)
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.error) {
                catalogLog.textContent += "Error: " + data.error + "\n";
                document.getElementById("catalog-progress").style.display = "none";
                return;
            }
            catalogJobId = data.job_id;
            pollCatalogJob();
        })
        .catch(function(err) {
            catalogLog.textContent += "Request failed: " + err + "\n";
            document.getElementById("catalog-progress").style.display = "none";
        });
    }

    function parseCatalogProgress(log) {
        // Parse "[NN%] X/Y files indexed (batch M/N)" from log lines
        var lines = log.split("\n");
        for (var i = lines.length - 1; i >= 0; i--) {
            var match = lines[i].match(/\[(\d+)%\]\s+(\d+)\/(\d+)\s+files indexed/);
            if (match) {
                return {pct: parseInt(match[1]), indexed: parseInt(match[2]), total: parseInt(match[3])};
            }
        }
        // Check for "Files found: N" as initial state
        for (var j = lines.length - 1; j >= 0; j--) {
            var foundMatch = lines[j].match(/Files found:\s+(\d+)/);
            if (foundMatch) {
                return {pct: 0, indexed: 0, total: parseInt(foundMatch[1])};
            }
        }
        return null;
    }

    function pollCatalogJob() {
        if (!catalogJobId) return;
        catalogPollTimer = setInterval(function() {
            fetch("/api/status/" + catalogJobId)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    catalogLog.textContent = data.log;
                    catalogLog.scrollTop = catalogLog.scrollHeight;

                    // Update progress bar
                    var prog = parseCatalogProgress(data.log);
                    if (prog) {
                        document.getElementById("catalog-progress-bar").style.width = prog.pct + "%";
                        document.getElementById("catalog-progress-pct").textContent = prog.pct + "%";
                        document.getElementById("catalog-progress-text").textContent =
                            prog.indexed + " / " + prog.total + " files indexed";
                    }

                    if (data.status !== "running") {
                        clearInterval(catalogPollTimer);
                        catalogJobId = null;
                        // Final progress
                        document.getElementById("catalog-progress-bar").style.width = "100%";
                        document.getElementById("catalog-progress-pct").textContent = "Done";
                        if (prog) {
                            document.getElementById("catalog-progress-text").textContent =
                                prog.indexed + " files indexed";
                        }
                        checkCatalogStatus();
                    }
                })
                .catch(function() {});
        }, 1000);
    }

    document.getElementById("btn-catalog-build").addEventListener("click", function() {
        var dir = getCatalogDir();
        if (!dir) { alert("Enter a directory first."); return; }

        // Check for existing subcatalogs before building
        catalogStatus.innerHTML = '<i class="bi bi-hourglass-split"></i> Checking for existing subcatalogs...';

        fetch("/api/catalog/subcatalogs?path=" + encodeURIComponent(dir))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                var subs = data.subcatalogs || [];
                if (subs.length === 0) {
                    if (!confirm("Build a new catalog? This will replace any existing one.")) return;
                    startCatalogJob("build");
                } else {
                    // Show subcatalog info and ask user
                    var msg = "Found " + subs.length + " subfolder" + (subs.length > 1 ? "s" : "") + " with existing catalogs:\n\n";
                    subs.forEach(function(s) {
                        msg += "  \u2022 " + s.relative + " (" + s.total_files + " files)\n";
                    });
                    msg += "\nChoose an action:\n";
                    msg += "  OK = Rebuild everything (replaces all subcatalogs)\n";
                    msg += "  Cancel = Skip those subfolders (keep their catalogs)";

                    if (confirm(msg)) {
                        startCatalogJob("build");
                    } else {
                        // Build with exclusions
                        startCatalogJob("build", subs.map(function(s) { return s.path; }));
                    }
                }
            })
            .catch(function() {
                if (!confirm("Build a new catalog? This will replace any existing one.")) return;
                startCatalogJob("build");
            });
    });

    document.getElementById("btn-catalog-update").addEventListener("click", function() {
        startCatalogJob("update");
    });

    document.getElementById("btn-catalog-prune").addEventListener("click", function() {
        startCatalogJob("prune");
    });

    document.getElementById("btn-catalog-remove").addEventListener("click", function() {
        var dir = getCatalogDir();
        if (!dir) return;
        if (!confirm("Delete the catalog database? This cannot be undone.")) return;
        fetch("/api/catalog/remove", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({path: dir})
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.ok) {
                catalogResults.style.display = "none";
                catalogLog.style.display = "none";
                checkCatalogStatus();
            }
        });
    });

    // Catalog search (overridden below to include structured filters)
    function runCatalogSearch(page) {}

    function prefetchCatalogPages(currentPage, totalPages) {
        // Prefetch thumbnails for the next 3 pages
        var dir = getCatalogDir();
        var query = catalogSearchQuery.value.trim();
        var filters = collectCatalogFilters();

        for (var ahead = 1; ahead <= 3; ahead++) {
            var nextPage = currentPage + ahead;
            if (nextPage > totalPages) break;

            var url = "/api/catalog/search?path=" + encodeURIComponent(dir) +
                      "&q=" + encodeURIComponent(query) +
                      "&page=" + nextPage + "&per_page=50";
            if (filters.length > 0) {
                url += "&filters=" + encodeURIComponent(JSON.stringify(filters));
            }

            (function(prefetchUrl) {
                fetch(prefetchUrl)
                    .then(function(res) { return res.json(); })
                    .then(function(data) {
                        if (!data.results) return;
                        data.results.forEach(function(r) {
                            var img = new Image();
                            img.src = "/api/thumbnail?path=" + encodeURIComponent(r.file_path) + "&size=200";
                        });
                    })
                    .catch(function() {});
            })(url);
        }
    }

    var catalogResultFiles = [];  // store for preview modal

    function openCatalogPreview(idx) {
        if (idx < 0 || idx >= catalogResultFiles.length) return;
        var r = catalogResultFiles[idx];
        var modalEl = document.getElementById("photoPreviewModal");
        var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        var previewImg = document.getElementById("photo-preview-img");
        var footer = document.getElementById("photo-preview-footer");
        var spinner = modalEl.querySelector(".preview-loading");

        previewImg.src = "";
        previewImg.style.display = "none";
        previewImg.alt = r.file_name;
        if (spinner) spinner.style.display = "flex";

        var loader = new Image();
        loader.onload = function() {
            previewImg.src = loader.src;
            previewImg.style.display = "block";
            if (spinner) spinner.style.display = "none";
        };
        loader.onerror = function() {
            previewImg.alt = "Failed to load: " + r.file_name;
            if (spinner) spinner.style.display = "none";
        };
        loader.src = "/api/thumbnail?path=" + encodeURIComponent(r.file_path) + "&size=1200";

        // Store path for EXIF/IPTC/download buttons
        modalEl.dataset.currentPath = r.file_path;
        updateDownloadButton(r.file_path);

        // Reset rotation
        _previewRotation = 0;
        previewImg.style.transform = "";

        // Hide metadata panel
        document.getElementById("preview-metadata-panel").style.display = "none";

        // Build footer with catalog metadata — full path first
        footer.innerHTML = "";
        if (r.file_path) {
            var pathEl = document.createElement("div");
            pathEl.className = "preview-meta-filepath";
            pathEl.textContent = '"' + r.file_path + '"';
            footer.appendChild(pathEl);
        }

        var fields = [];
        if (r.model) fields.push(["Camera", r.model]);
        if (r.lens_model) fields.push(["Lens", r.lens_model]);
        if (r.date_time_original) fields.push(["Date", r.date_time_original]);
        if (r.f_number) fields.push(["Aperture", "f/" + r.f_number]);
        if (r.focal_length) fields.push(["Focal", r.focal_length + "mm"]);
        if (r.iso) fields.push(["ISO", r.iso]);
        if (r.image_width && r.image_height) fields.push(["Size", r.image_width + "\u00d7" + r.image_height]);
        if (r.gps_latitude && r.gps_longitude) fields.push(["GPS", Number(r.gps_latitude).toFixed(4) + ", " + Number(r.gps_longitude).toFixed(4)]);
        if (r.headline) fields.push(["Headline", r.headline]);
        if (r.caption) fields.push(["Caption", r.caption]);
        if (r.keywords) fields.push(["Keywords", r.keywords]);
        if (r.city || r.state || r.country) fields.push(["Location", [r.city, r.state, r.country].filter(Boolean).join(", ")]);

        fields.forEach(function(pair) {
            var div = document.createElement("div");
            div.className = "preview-meta-field";
            var label = document.createElement("span");
            label.className = "preview-meta-label";
            label.textContent = pair[0];
            div.appendChild(label);
            div.appendChild(document.createTextNode(pair[1]));
            footer.appendChild(div);
        });

        document.getElementById("photo-preview-title").textContent = r.file_name;
        modal.show();
    }

    function renderCatalogResults(results) {
        catalogResultsGrid.innerHTML = "";
        catalogResultFiles = results;
        if (results.length === 0) return;

        results.forEach(function(r, idx) {
            var card = document.createElement("div");
            card.className = "search-result-card";
            card.style.cursor = "pointer";

            card.addEventListener("click", function() {
                openCatalogPreview(idx);
            });

            var img = document.createElement("img");
            img.loading = "eager";
            img.src = "/api/thumbnail?path=" + encodeURIComponent(r.file_path) + "&size=200";
            img.alt = r.file_name;
            card.appendChild(img);

            var meta = document.createElement("div");
            meta.className = "search-result-meta";

            var fn = document.createElement("div");
            fn.className = "search-result-filename";
            fn.textContent = r.file_name;
            meta.appendChild(fn);

            var details = [];
            if (r.model) details.push(r.model);
            if (r.date_time_original) details.push(r.date_time_original.split(" ")[0]);
            if (r.focal_length) details.push(r.focal_length + "mm");
            if (r.f_number) details.push("f/" + r.f_number);
            if (r.iso) details.push("ISO " + r.iso);

            if (details.length > 0) {
                var detailEl = document.createElement("div");
                detailEl.className = "search-result-field";
                detailEl.textContent = details.join(" \u00b7 ");
                meta.appendChild(detailEl);
            }

            if (r.headline) {
                var hl = document.createElement("div");
                hl.className = "search-result-field";
                hl.style.color = "var(--ps-accent)";
                hl.textContent = r.headline;
                meta.appendChild(hl);
            }

            if (r.keywords) {
                var kw = document.createElement("div");
                kw.className = "search-result-field";
                kw.style.fontSize = "10px";
                kw.textContent = r.keywords;
                meta.appendChild(kw);
            }

            card.appendChild(meta);
            catalogResultsGrid.appendChild(card);
        });
    }

    function renderCatalogPagination(currentPage, totalPages) {
        catalogResultsPagination.innerHTML = "";
        if (totalPages <= 1) return;

        if (currentPage > 1) {
            var prev = document.createElement("button");
            prev.type = "button";
            prev.className = "btn btn-sm btn-photoshell";
            prev.textContent = "\u2190 Previous";
            prev.addEventListener("click", function() { runCatalogSearch(currentPage - 1); });
            catalogResultsPagination.appendChild(prev);
        }

        var info = document.createElement("span");
        info.style.cssText = "font-size:12px;color:var(--ps-text-muted);align-self:center";
        info.textContent = "Page " + currentPage + " of " + totalPages;
        catalogResultsPagination.appendChild(info);

        if (currentPage < totalPages) {
            var next = document.createElement("button");
            next.type = "button";
            next.className = "btn btn-sm btn-photoshell";
            next.textContent = "Next \u2192";
            next.addEventListener("click", function() { runCatalogSearch(currentPage + 1); });
            catalogResultsPagination.appendChild(next);
        }
    }

    document.getElementById("btn-catalog-search").addEventListener("click", function() {
        runCatalogSearch(1);
    });

    catalogSearchQuery.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            runCatalogSearch(1);
        }
    });

    // ---- Catalog Structured Filters (same pattern as Structured tab) ----

    var _catalogSchema = null;
    var _catalogActiveFilters = {};
    var catalogExifList = document.getElementById("catalog-exif-filter-list");
    var catalogIptcList = document.getElementById("catalog-iptc-filter-list");
    var catalogAddFieldSelect = document.getElementById("catalog-add-field");

    document.getElementById("btn-catalog-discover").addEventListener("click", function() {
        var dir = getCatalogDir();
        if (!dir) return;
        var status = document.getElementById("catalog-discover-status");
        status.innerHTML = '<i class="bi bi-hourglass-split"></i> Discovering fields...';

        fetch("/api/catalog/discover?path=" + encodeURIComponent(dir))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) { status.textContent = data.error; return; }
                _catalogSchema = data;
                var total = (data.exif_fields || []).length + (data.iptc_fields || []).length;
                status.innerHTML = '<span style="color:var(--ps-success)">' + total + ' fields discovered</span>';

                // Render default fields
                catalogExifList.innerHTML = "";
                catalogIptcList.innerHTML = "";
                _catalogActiveFilters = {};

                // Show default fields: model, date, iso, f_number, focal_length, keywords, headline
                var defaults = ["model", "date_time_original", "iso", "f_number", "focal_length", "keywords", "headline"];
                var allFields = (data.exif_fields || []).concat(data.iptc_fields || []);
                defaults.forEach(function(fieldCol) {
                    var f = allFields.find(function(x) { return x.field === fieldCol; });
                    if (f) addCatalogFilterField(f);
                });

                refreshCatalogAddFieldDropdown();
                document.getElementById("catalog-structured-fields").style.display = "";
            })
            .catch(function() { status.textContent = "Failed to discover fields"; });
    });

    function addCatalogFilterField(field) {
        if (_catalogActiveFilters[field.field]) return;
        _catalogActiveFilters[field.field] = true;

        // Reuse the exact same renderFilterRow function from the Structured tab
        var row = renderFilterRow(field, field.field in _IPTC_COLUMNS_SET ? "iptc" : "exif");

        // Override the remove handler to work with catalog state
        var removeBtn = row.querySelector(".filter-remove");
        if (removeBtn) {
            // Remove old handler by cloning
            var newBtn = removeBtn.cloneNode(true);
            removeBtn.parentNode.replaceChild(newBtn, removeBtn);
            newBtn.addEventListener("click", function() {
                row.parentNode.removeChild(row);
                delete _catalogActiveFilters[field.field];
                refreshCatalogAddFieldDropdown();
            });
        }

        if (field.field in _IPTC_COLUMNS_SET) {
            catalogIptcList.appendChild(row);
        } else {
            catalogExifList.appendChild(row);
        }
    }

    function refreshCatalogAddFieldDropdown() {
        if (!_catalogSchema) return;
        catalogAddFieldSelect.innerHTML = '<option value="">+ Add field...</option>';
        var allFields = (_catalogSchema.exif_fields || []).concat(_catalogSchema.iptc_fields || []);
        allFields.forEach(function(f) {
            if (_catalogActiveFilters[f.field]) return;
            var opt = document.createElement("option");
            opt.value = f.field;
            opt.textContent = f.name;
            catalogAddFieldSelect.appendChild(opt);
        });
    }

    catalogAddFieldSelect.addEventListener("change", function() {
        var fieldCol = catalogAddFieldSelect.value;
        if (!fieldCol || !_catalogSchema) return;
        var allFields = (_catalogSchema.exif_fields || []).concat(_catalogSchema.iptc_fields || []);
        var field = allFields.find(function(f) { return f.field === fieldCol; });
        if (field) {
            addCatalogFilterField(field);
            refreshCatalogAddFieldDropdown();
        }
        catalogAddFieldSelect.value = "";
    });

    // Set for quick IPTC lookup
    var _IPTC_COLUMNS_SET = {"headline":1,"caption":1,"keywords":1,"copyright":1,"credit":1,"source":1,"city":1,"state":1,"country":1};

    function collectCatalogFilters() {
        var filters = [];
        var containers = [catalogExifList, catalogIptcList];
        containers.forEach(function(container) {
            container.querySelectorAll(".structured-filter-row").forEach(function(row) {
                var fieldCol = row.dataset.fieldName;
                var filterMode = row.dataset.filterMode || "";
                var fieldType = row.dataset.fieldType || "text";

                if (filterMode === "regex" || filterMode === "keywords_all") {
                    var valEl = row.querySelector('[data-role="value"]');
                    var val = valEl ? valEl.value.trim() : "";
                    if (val) filters.push({field: fieldCol, op: "contains", value: val});
                } else if (fieldType === "numeric" || fieldType === "date") {
                    var minEl = row.querySelector('[data-role="min"]');
                    var maxEl = row.querySelector('[data-role="max"]');
                    var minVal = minEl ? minEl.value.trim() : "";
                    var maxVal = maxEl ? maxEl.value.trim() : "";
                    if (minVal || maxVal) {
                        filters.push({field: fieldCol, op: "range", min: minVal || null, max: maxVal || null});
                    }
                } else if (fieldType === "select") {
                    var cbGroup = row.querySelector('[data-role="values"]');
                    if (cbGroup) {
                        var checked = [];
                        cbGroup.querySelectorAll("input:checked").forEach(function(cb) {
                            checked.push(cb.value);
                        });
                        if (checked.length > 0) filters.push({field: fieldCol, op: "in", values: checked});
                    }
                } else {
                    var textEl = row.querySelector('[data-role="value"]');
                    var textVal = textEl ? textEl.value.trim() : "";
                    if (textVal) filters.push({field: fieldCol, op: "contains", value: textVal});
                }
            });
        });
        return filters;
    }

    // Wire up the structured search button
    document.getElementById("btn-catalog-structured-search").addEventListener("click", function() {
        runCatalogSearch(1);
    });

    // Include structured filters in catalog search
    var _origRunCatalogSearch = runCatalogSearch;
    runCatalogSearch = function(page) {
        var dir = getCatalogDir();
        var query = catalogSearchQuery.value.trim();
        if (!dir) return;

        catalogCurrentPage = page || 1;
        catalogResultsHeader.textContent = "Searching...";
        catalogResults.style.display = "block";
        catalogResultsGrid.innerHTML = "";
        catalogResultsPagination.innerHTML = "";

        var filters = collectCatalogFilters();
        var url = "/api/catalog/search?path=" + encodeURIComponent(dir) +
                  "&q=" + encodeURIComponent(query) +
                  "&page=" + catalogCurrentPage + "&per_page=50";
        if (filters.length > 0) {
            url += "&filters=" + encodeURIComponent(JSON.stringify(filters));
        }

        fetch(url)
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    catalogResultsHeader.textContent = data.error;
                    return;
                }
                catalogResultsHeader.textContent =
                    data.total + " result" + (data.total !== 1 ? "s" : "") +
                    " (page " + data.page + " of " + data.total_pages + ")";
                renderCatalogResults(data.results);
                renderCatalogPagination(data.page, data.total_pages);
                prefetchCatalogPages(data.page, data.total_pages);
            })
            .catch(function() {
                catalogResultsHeader.textContent = "Search failed";
            });
    };

    // ---- Backup Folder ----

    var btnBackupEstimate = document.getElementById("btn-backup-estimate");
    var btnBackupRun      = document.getElementById("btn-backup-run");
    var btnBackupCancel   = document.getElementById("btn-backup-cancel");
    var backupLog         = document.getElementById("backup-log");
    var backupEstimateEl  = document.getElementById("backup-estimate");
    var backupDestInput   = document.getElementById("backup-dest");
    var backupRecursive   = document.getElementById("backup-recursive");
    var backupJobId       = null;
    var backupPollTimer   = null;

    document.getElementById("btn-backup-browse-dest").addEventListener("click", function() {
        browserTarget = "backup-dest";
        var startPath = backupDestInput.value.trim() || photoDirInput.value.trim() || "/";
        browseToPath(startPath);
        browserModal.show();
    });

    function getBackupPayload() {
        return {
            source: photoDirInput.value.trim(),
            dest: backupDestInput.value.trim(),
            recursive: backupRecursive.checked
        };
    }

    btnBackupEstimate.addEventListener("click", function() {
        var payload = getBackupPayload();
        if (!payload.source) {
            alert("Please specify a source folder or set a workflow directory.");
            return;
        }

        backupEstimateEl.innerHTML = '<span class="text-muted"><i class="bi bi-hourglass-split"></i> Estimating...</span>';
        backupEstimateEl.style.display = "block";

        fetch("/api/backup/estimate", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.error) {
                backupEstimateEl.innerHTML = '<span class="be-error"><i class="bi bi-x-circle"></i> ' + escapeHtml(data.error) + '</span>';
                return;
            }

            var html = '<div class="be-grid">';
            html += '<div class="be-item"><span class="be-label">Source</span><span class="be-value">' + escapeHtml(data.source) + '</span></div>';
            html += '<div class="be-item"><span class="be-label">Destination</span><span class="be-value">' + escapeHtml(data.dest) + '</span></div>';
            html += '<div class="be-item"><span class="be-label">Files</span><span class="be-value">' + data.file_count;
            if (data.recursive && data.dir_count > 0) {
                html += ' <small>(' + data.dir_count + ' subdirs)</small>';
            }
            html += '</span></div>';
            html += '<div class="be-item"><span class="be-label">Source size</span><span class="be-value">' + escapeHtml(data.size_human) + '</span></div>';
            html += '<div class="be-item"><span class="be-label">Est. archive</span><span class="be-value">' + escapeHtml(data.estimated_archive_human) + '</span></div>';

            var spaceClass = data.space_ok ? "be-space-ok" : "be-space-warn";
            html += '<div class="be-item"><span class="be-label">Available space</span><span class="be-value ' + spaceClass + '">' + escapeHtml(data.avail_human);
            if (!data.space_ok) {
                html += ' <i class="bi bi-exclamation-triangle-fill"></i> insufficient';
            }
            html += '</span></div>';
            html += '</div>';

            backupEstimateEl.innerHTML = html;
        })
        .catch(function(err) {
            backupEstimateEl.innerHTML = '<span class="be-error"><i class="bi bi-x-circle"></i> Estimate failed: ' + escapeHtml(String(err)) + '</span>';
        });
    });

    btnBackupRun.addEventListener("click", function() {
        var payload = getBackupPayload();
        if (!payload.source) {
            alert("Please specify a source folder or set a workflow directory.");
            return;
        }

        btnBackupRun.disabled = true;
        btnBackupEstimate.disabled = true;
        btnBackupCancel.style.display = "inline-block";
        backupLog.style.display = "block";
        backupLog.classList.add("active");
        backupLog.textContent = "Starting backup of " + payload.source + " ...\n";

        fetch("/api/backup/run", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        })
        .then(function(res) { return res.json(); })
        .then(function(body) {
            if (body.error) {
                backupLog.textContent = "Error: " + body.error;
                btnBackupRun.disabled = false;
                btnBackupEstimate.disabled = false;
                btnBackupCancel.style.display = "none";
                return;
            }
            backupJobId = body.job_id;
            startBackupPolling();
        })
        .catch(function(err) {
            backupLog.textContent = "Request failed: " + err;
            btnBackupRun.disabled = false;
            btnBackupEstimate.disabled = false;
            btnBackupCancel.style.display = "none";
        });
    });

    btnBackupCancel.addEventListener("click", function() {
        if (!backupJobId) return;
        fetch("/api/cancel/" + backupJobId, {method: "POST"});
    });

    function startBackupPolling() {
        backupPollTimer = setInterval(function() {
            if (!backupJobId) return;
            fetch("/api/status/" + backupJobId)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    backupLog.textContent = data.log;
                    backupLog.scrollTop = backupLog.scrollHeight;
                    if (data.status !== "running") {
                        clearInterval(backupPollTimer);
                        btnBackupRun.disabled = false;
                        btnBackupEstimate.disabled = false;
                        btnBackupCancel.style.display = "none";
                        backupJobId = null;
                    }
                })
                .catch(function() { /* ignore transient errors */ });
        }, 1000);
    }

    // ---- Reset button ----

    document.getElementById("btn-reset").addEventListener("click", function() {
        if (!confirm("Reset all workflow settings to defaults?")) return;

        // Uncheck all step checkboxes
        document.querySelectorAll(".section-toggle").forEach(function(cb) {
            cb.checked = false;
        });

        // Reset all text/number inputs to defaults
        form.querySelectorAll("input[type=text], input[type=number]").forEach(function(el) {
            el.value = el.defaultValue;
        });

        // Reset all selects to first option
        form.querySelectorAll("select").forEach(function(sel) {
            sel.selectedIndex = 0;
        });

        // Reset all checkboxes inside step configs to defaults
        document.querySelectorAll(".step-config input[type=checkbox]").forEach(function(cb) {
            cb.checked = cb.defaultChecked;
        });
        document.querySelectorAll(".step-config input[type=text], .step-config input[type=number]").forEach(function(el) {
            el.value = el.defaultValue;
        });
        document.querySelectorAll(".step-config select").forEach(function(sel) {
            sel.selectedIndex = 0;
        });

        // Clear step selection order
        selectionOrder = [];
        updateStepSequencing();

        // Close inspector
        closeInspector();

        // Reset preset dropdown
        if (presetSelect) presetSelect.value = "";

        // Clear validation state
        folderValid = false;
        photoDirInput.classList.remove("is-valid", "is-invalid");
        setFolderStatus("");
        hideFolderMetaStats();
        hidePhotoThumbs();
        hideContentViewTabs();
        updateHeaderMeta(null);
        lastResolvedPath = "";
    });

    // ---- Drag-and-Drop folder selection ----

    var dropOverlay = document.getElementById("drop-overlay");
    var dragCounter = 0;

    document.addEventListener("dragenter", function(e) {
        e.preventDefault();
        dragCounter++;
        if (dragCounter === 1) {
            dropOverlay.classList.add("active");
        }
    });

    document.addEventListener("dragover", function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });

    document.addEventListener("dragleave", function(e) {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropOverlay.classList.remove("active");
        }
    });

    document.addEventListener("drop", function(e) {
        e.preventDefault();
        dragCounter = 0;
        dropOverlay.classList.remove("active");

        // Try to extract a folder path from the dropped items
        var items = e.dataTransfer.items;
        if (items && items.length > 0) {
            var entry = items[0].webkitGetAsEntry && items[0].webkitGetAsEntry();
            if (entry && entry.isDirectory) {
                // Directory dropped — fullPath gives the relative path
                // For local Flask, we need the absolute path from the file list
                photoDirInput.value = entry.fullPath;
                validateFolder(entry.fullPath);
                return;
            }
        }

        // Fallback: extract directory from dropped files' webkitRelativePath
        var files = e.dataTransfer.files;
        if (files && files.length > 0) {
            var relPath = files[0].webkitRelativePath;
            if (relPath) {
                // webkitRelativePath is "folder/subfolder/file.jpg" — extract the top folder
                var parts = relPath.split("/");
                if (parts.length > 1) {
                    photoDirInput.value = parts[0];
                    validateFolder(parts[0]);
                    return;
                }
            }
            // Last resort: show a hint
            photoDirInput.focus();
            photoDirInput.placeholder = "Paste the folder path here (browser security prevents auto-fill)";
        }
    });

    // ---- Keyboard shortcuts ----

    document.addEventListener("keydown", function(e) {
        // Don't fire shortcuts when typing in inputs/textareas
        var tag = document.activeElement ? document.activeElement.tagName : "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        if (e.key === "r" || e.key === "R") {
            e.preventDefault();
            if (!btnRun.disabled) btnRun.click();
        } else if (e.key === "Escape") {
            e.preventDefault();
            if (btnCancel.style.display !== "none") btnCancel.click();
        } else if (e.key === "/") {
            e.preventDefault();
            photoDirInput.focus();
        } else if (e.key === "v" || e.key === "V") {
            e.preventDefault();
            if (btnValidateWf) btnValidateWf.click();
        } else if (e.key === "?") {
            e.preventDefault();
            openDocsModal("web_ui_help");
        }
    });
});
