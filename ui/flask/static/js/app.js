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
    var folderStatus   = document.getElementById("folder-status");
    var logPanel       = document.getElementById("log-panel");
    var progressBar    = document.getElementById("pipeline-progress");
    var stepsContainer = document.getElementById("pipeline-steps");

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

    var currentJobId = null;
    var pollTimer    = null;
    var folderValid  = false;
    var validateTimer = null;
    var pendingMermaidDivs = null; // mermaid divs waiting for modal shown event
    var orderOverride = false; // user acknowledged ordering concerns

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
        docsTitle.innerHTML = '<i class="bi bi-book"></i> Loading...';
        docsModal.show();

        fetch("/api/docs/" + encodeURIComponent(docKey))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    docsLoading.style.display = "none";
                    docsContent.style.display = "block";
                    docsContent.innerHTML = '<div class="text-danger">Error: ' + data.error + '</div>';
                    return;
                }

                docsTitle.innerHTML = '<i class="bi bi-book"></i> ' + data.filename;

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
            })
            .catch(function(err) {
                docsLoading.style.display = "none";
                docsContent.style.display = "block";
                docsContent.innerHTML = '<div class="text-danger">Failed to load documentation: ' + err + '</div>';
            });
    }

    // ---- Step sequencing and order validation ----

    // Recommended workflow order. The core pipeline is:
    //   1. Sync EXIF from originals to exports
    //   2. Fill GPS gaps (everything downstream depends on GPS)
    //   3. Extract photo summary (uses GPS for reverse geocoding)
    //   4. Annotate descriptions (uses summary + GPS context)
    //   5. Annotate keywords (uses description + GPS context)
    // Then renaming, output, and cleanup:
    //   6. Geo rename (uses GPS for location-based filenames)
    //   7. GoPro geo rename (same GPS dependency)
    //   8. Detect blurry (independent of metadata content)
    //   9. Contact sheet (benefits from all metadata being final)
    //  10. Scrub metadata (destructive - must be after all writes)
    //  11. Search EXIF/IPTC (read-only query, always last)
    var STEP_RECOMMENDED_ORDER = {
        "enable_sync_exif":        1,
        "enable_gps_gap_fill":     2,
        "enable_extract_summary":  3,
        "enable_annotate_desc":    4,
        "enable_annotate_kw":      5,
        "enable_geo_rename":       6,
        "enable_gopro":            7,
        "enable_blur":             8,
        "enable_contact_sheet":    9,
        "enable_scrub":           10,
        "enable_search":          11
    };

    var STEP_LABELS = {
        "enable_sync_exif":       "Sync EXIF & Rename",
        "enable_gps_gap_fill":    "GPS Gap Fill",
        "enable_extract_summary": "Extract Photo Summary",
        "enable_annotate_desc":   "Annotate - Description",
        "enable_annotate_kw":     "Annotate - Keywords",
        "enable_blur":            "Detect Blurry Photos",
        "enable_geo_rename":      "Geo Rename Photos",
        "enable_gopro":           "GoPro Geo Rename",
        "enable_contact_sheet":   "Contact Sheet",
        "enable_scrub":           "Scrub Metadata",
        "enable_search":          "Search EXIF / IPTC"
    };

    // Dependency rules. "before" must run before "after".
    // Organized by the key dependency chain:
    //   GPS data -> summary -> descriptions -> keywords -> outputs -> cleanup
    var ORDER_RULES = [
        // --- Sync EXIF is the foundation ---
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

        // --- GPS Gap Fill is the critical gate ---
        // Everything that uses location (summary, annotations, renaming)
        // must wait until GPS coordinates are filled in.
        {
            before: "enable_gps_gap_fill",
            after: "enable_extract_summary",
            reason: "Extract Summary uses GPS for reverse geocoding. Without GPS Gap Fill, photos missing coordinates will have no location in their summary."
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

        // --- Extract Summary feeds into annotations ---
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

        // --- Description before keywords ---
        {
            before: "enable_annotate_desc",
            after: "enable_annotate_kw",
            reason: "The keyword prompt reads the generated description to produce more relevant keywords. Descriptions must be written first."
        },

        // --- Renaming should happen after metadata is written ---
        // (Geo rename changes filenames; scripts that process by filename
        //  should either run before renaming, or not care about names.)
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

        // --- Contact sheet should capture final metadata ---
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

        // --- Scrub is destructive - must be after all metadata writes ---
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
                badge.classList.remove("step-warn");
            } else {
                badge.textContent = "Step";
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

        // 3) Step-specific validation
        if (data.enable_search && !data.search_query) {
            result.valid = false;
            result.errors.push("Search EXIF/IPTC is enabled but no search query is specified.");
        }

        // 4) Ordering issues
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

    // ---- Toggle accordion sections based on checkboxes in the header ----

    document.querySelectorAll(".section-toggle").forEach(function(cb) {
        var target = cb.dataset.section;
        var sec = document.getElementById(target);
        var item = sec ? sec.closest(".accordion-item") : null;
        if (!item) return;

        function syncState() {
            if (cb.checked) {
                item.classList.remove("disabled");
                // Track selection order: append if not already present
                if (selectionOrder.indexOf(cb.name) === -1) {
                    selectionOrder.push(cb.name);
                }
            } else {
                item.classList.add("disabled");
                var collapse = item.querySelector(".accordion-collapse");
                if (collapse && collapse.classList.contains("show")) {
                    bootstrap.Collapse.getOrCreateInstance(collapse).hide();
                }
                // Remove from selection order
                var idx = selectionOrder.indexOf(cb.name);
                if (idx >= 0) selectionOrder.splice(idx, 1);
            }
            updateStepSequencing();
        }

        cb.addEventListener("change", syncState);
        syncState();
    });

    // ---- Folder Validation ----

    function setFolderStatus(html, cls) {
        folderStatus.innerHTML = html;
        folderStatus.className = "mt-1 " + (cls || "");
    }

    function validateFolder(path) {
        if (!path) {
            setFolderStatus("");
            photoDirInput.classList.remove("is-valid", "is-invalid");
            folderValid = false;
            return;
        }

        setFolderStatus('<i class="bi bi-hourglass-split"></i> Checking...', "text-secondary");

        fetch("/api/validate_folder?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (!data.valid) {
                    setFolderStatus(
                        '<i class="bi bi-x-circle-fill"></i> ' + data.reason,
                        "text-danger"
                    );
                    photoDirInput.classList.remove("is-valid");
                    photoDirInput.classList.add("is-invalid");
                    folderValid = false;
                } else if (data.warning) {
                    setFolderStatus(
                        '<i class="bi bi-exclamation-triangle-fill"></i> ' + data.warning +
                        ' <span class="text-muted">(resolved: ' + data.path + ')</span>',
                        "text-warning"
                    );
                    photoDirInput.classList.remove("is-invalid");
                    photoDirInput.classList.add("is-valid");
                    folderValid = true;
                } else {
                    setFolderStatus(
                        '<i class="bi bi-check-circle-fill"></i> ' +
                        data.photo_count + ' photo file' + (data.photo_count !== 1 ? 's' : '') +
                        ' found <span class="text-muted">(resolved: ' + data.path + ')</span>',
                        "text-success"
                    );
                    photoDirInput.classList.remove("is-invalid");
                    photoDirInput.classList.add("is-valid");
                    folderValid = true;
                }
            })
            .catch(function() {
                setFolderStatus(
                    '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                    "text-danger"
                );
                folderValid = false;
            });
    }

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
            photoDirInput.classList.remove("is-valid", "is-invalid");
            folderValid = false;
            return;
        }
        validateTimer = setTimeout(function() {
            validateFolder(val);
        }, 600);
    });

    // ---- Folder Browser ----

    function browseToPath(path) {
        browserList.innerHTML = '<div class="text-muted p-3"><i class="bi bi-hourglass-split"></i> Loading...</div>';
        browserPathInput.value = path;

        fetch("/api/browse?path=" + encodeURIComponent(path))
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.error) {
                    browserList.innerHTML = '<div class="text-danger p-3">' + data.error + '</div>';
                    return;
                }

                browserPathInput.value = data.current;
                var html = "";

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
                    var fullPath = data.current + (data.current.endsWith("/") ? "" : "/") + data.dirs[i];
                    html += '<div class="browser-item" data-path="' + escapeAttr(fullPath) + '">' +
                            '<i class="bi bi-folder-fill" style="color:#aaa"></i> ' +
                            escapeHtml(data.dirs[i]) +
                            '</div>';
                }

                browserList.innerHTML = html;

                // Click handlers for directory items
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

    browserPathInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
            e.preventDefault();
            browseToPath(browserPathInput.value.trim() || "/");
        }
    });

    browserSelectBtn.addEventListener("click", function() {
        var selected = browserPathInput.value.trim();
        if (selected) {
            photoDirInput.value = selected;
            validateFolder(selected);
        }
        browserModal.hide();
    });

    // ---- Collect form data ----

    function collectFormData() {
        var data = {};
        form.querySelectorAll("input[type=text], input[type=number], select").forEach(function(el) {
            if (el.name) data[el.name] = el.value.trim();
        });
        form.querySelectorAll("input[type=checkbox]").forEach(function(el) {
            if (el.name) data[el.name] = el.checked;
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
                    showValidationResult(validateWorkflow());
                })
                .catch(function() {
                    setFolderStatus(
                        '<i class="bi bi-x-circle-fill"></i> Validation request failed',
                        "text-danger"
                    );
                    showValidationResult(validateWorkflow());
                });
            return;
        }

        showValidationResult(validateWorkflow());
    });

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
            html = '<div class="vr-item vr-ok"><i class="bi bi-check-circle" style="font-size:.75rem"></i> Workflow is valid. Folder, steps, and ordering all check out.</div>';
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
        var v = validateWorkflow();

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

    function startPipeline(data) {
        btnRun.disabled = true;
        btnCancel.style.display = "inline-block";
        logPanel.classList.add("active");
        progressBar.classList.add("active");

        // Show header with override notice if applicable
        var header = "Starting pipeline...\n";
        if (orderOverride) {
            header += "NOTE: Running with user-overridden step order.\n";
        }
        logPanel.textContent = header;

        fetch("/api/run", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data),
        })
        .then(function(res) { return res.json(); })
        .then(function(body) {
            if (body.error) {
                logPanel.textContent = "Error: " + body.error;
                btnRun.disabled = false;
                btnCancel.style.display = "none";
                return;
            }
            currentJobId = body.job_id;
            renderStepBadges(body.steps);
            startPolling();
        })
        .catch(function(err) {
            logPanel.textContent = "Request failed: " + err;
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
            fetch("/api/status/" + currentJobId)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    logPanel.textContent = data.log;
                    logPanel.scrollTop = logPanel.scrollHeight;
                    updateStepBadges(data);

                    if (data.status !== "running") {
                        clearInterval(pollTimer);
                        btnRun.disabled = false;
                        btnCancel.style.display = "none";
                        currentJobId = null;
                    }
                })
                .catch(function() { /* ignore transient errors */ });
        }, 1000);
    }

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
});
