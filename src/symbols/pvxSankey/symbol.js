/* ============================================================================
 * pvxSankey — weighted flow (Sankey) diagram for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * The question this symbol answers is "of everything that goes in, where does it
 * actually come out". An energy balance, a water balance, mass through a
 * process: the ribbon widths are the numbers, so a loss stream that ought to be
 * a trickle and is not is visible from across the control room.
 *
 * THE HONEST DIFFICULTY
 *   The PI System has no graph structure to read. A tag knows its own value; it
 *   does not know what it flows into. There is no server-side relationship
 *   between "Boiler steam flow" and "Turbine steam flow" that this symbol could
 *   discover. So the topology has to be AUTHORED, in the config, by somebody who
 *   knows the plant. That makes this symbol excellent for a fixed, well
 *   understood process and awkward for anything ad hoc — and that trade is
 *   stated in the config pane, not buried here.
 *
 *   Because a freshly dropped symbol has no topology at all, AutoTopology builds
 *   a plausible one (first source -> hub -> every other source) so the engineer
 *   sees the shape of the thing immediately. It is labelled as automatic in the
 *   footer every single frame: an invented topology that looks authored is a lie
 *   about the plant.
 *
 * COLUMN SYNC
 *   PI Vision returns Summary cells positionally, matching config.Columns, so
 *   the chosen statistic must drive that array or the ribbons are sized by the
 *   wrong aggregate with no error anywhere. All of it lives in the shared
 *   helpers (PVX.config.statColumns / syncStatColumns / PVX.data.statValue),
 *   called from onConfigChange AND from the top of render so a display saved by
 *   an older build repairs itself on load.
 *
 * LAYOUT (see layoutGraph and the functions above it)
 *   1. parse the links, build the node set
 *   2. break cycles — a cycle makes ranking impossible; the dropped link is
 *      NAMED in the footer rather than hanging or silently mangling the diagram
 *   3. rank by longest path from a source, so a node sits right of everything
 *      feeding it
 *   4. order within each rank by barycentre to reduce crossings
 *   5. node size proportional to max(inflow, outflow)
 *   6. link positions within a node ordered to match the neighbouring rank
 *   7. cubic Bezier ribbons whose thickness IS the flow value
 *
 * HONESTY RULES
 *   - A negative or zero flow has no ribbon width. It is dropped and NAMED in
 *     the footer; silently dropping a stream is how a display lies.
 *   - A node whose inflow and outflow disagree by more than BalanceTolerance is
 *     marked. That is the feature that turns a pretty diagram into an
 *     instrument: an unbalanced node is a leak, a bad meter or a missing tag.
 *   - Every label is measured with getComputedTextLength() before it is kept.
 *     Glyph-width estimation has been a real source of overflow bugs here.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxSankey',
        displayName: 'PVX Flow',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: { Links: 'links' },
        visObjectType: symbolVis,
        // A collection would repeat the whole balance per asset. The topology is
        // authored against one specific set of data sources, so repeating it
        // against a different asset's tags would draw the wrong plant.
        supportsCollections: false,
        configTitle: 'Format Flow',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells; kept in
                // step with Statistic by PVX.config.syncStatColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                Height: 300,
                Width: 520,

                Title: '',                  // blank => generic heading

                // --- what sizes a ribbon -----------------------------
                Statistic: 'Value',         // Value|Average|Minimum|Maximum|Range|StdDev|Total

                // --- topology ----------------------------------------
                // "From > To : sourceIndex", entries separated by ' | '.
                Links: '',
                AutoTopology: true,

                // --- geometry ----------------------------------------
                Orientation: 'horizontal',  // horizontal | vertical
                NodeWidth: 14,
                NodePadding: 12,
                LinkOpacity: 0.45,
                LinkCurvature: 0.5,

                // --- colour ------------------------------------------
                ColorMode: 'node',          // node | link | single | threshold
                SingleColor: '#3b82c4',
                NodeColors: '',             // "Vent:#c8452f, Product:#3f9e6a"

                // --- labels ------------------------------------------
                ShowNodeLabels: true,
                ShowNodeValues: true,
                ShowLinkValues: false,
                LabelPosition: 'outside',   // outside | inside

                // --- the instrument ----------------------------------
                ShowBalance: true,
                BalanceTolerance: 2,        // percent
                HighlightLoss: '',          // comma separated node names
                MinLinkValue: 0
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; every ribbon and node is SVG.
        scope.pvx = {
            title: '', subtitle: '', note: '', count: '', error: '',
            background: '', showHeader: false, showFooter: false
        };

        var rows = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-sk-body',

            onData: function (d) {
                // Parse against exactly the column the chosen statistic asks
                // for — see PVX.config.statColumns.
                rows = PVX.data.rows(d, PVX.config.statColumns(scope.config || {})) || [];
            },

            onConfigChange: function (newCfg) {
                // The statistic decides which aggregate PI Vision computes, so
                // the request has to be corrected before the next fetch.
                PVX.config.syncStatColumns(newCfg || scope.config);
            },

            render: render
        });

        /* ================================================================ *
         * Small helpers
         * ================================================================ */

        function numIn(v, lo, hi, fallback) {
            var n = PVX.util.num(v);
            if (n === null) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        /**
         * Key prefix for every string-keyed map in this file.
         *
         * Node names come from a config string and from tag names, so they can
         * legitimately be "constructor" or "__proto__". A bare object literal
         * used as a map would then either report a phantom hit or silently
         * refuse the assignment, and the diagram would lose a node for reasons
         * nobody could ever debug from the display.
         */
        function key(name) { return 'n:' + String(name); }

        function lower(s) { return String(s === null || s === undefined ? '' : s).toLowerCase(); }

        /* ================================================================ *
         * Topology grammar
         * ================================================================ *
         *   "Feed > Reactor : 1 | Reactor > Product : 2 | Reactor > Vent : 3"
         *
         * ' | ' separates the links; '>' separates the two node names; the last
         * ':' separates the 1-based data source index that supplies the
         * magnitude. Whitespace around every token is insignificant.
         *
         * The outer separator is deliberately NOT a comma: node names are free
         * text typed by an engineer and commas turn up in them ("Header, North").
         * The source index is taken from the LAST colon so a node name may
         * contain one too.
         */
        function parseLinks(spec, bad) {
            var out = [];
            var raw = String(spec === null || spec === undefined ? '' : spec);
            if (!raw.replace(/\s+/g, '')) { return out; }

            var parts = raw.split('|');
            for (var i = 0; i < parts.length; i++) {
                var s = parts[i].trim();
                if (!s) { continue; }        // trailing separator, not an error

                var gt = s.indexOf('>');
                if (gt === -1) { bad.push(s); continue; }

                // Everybody types "A -> B" sooner or later. Splitting on the
                // first '>' would then create a node literally called "A -",
                // which draws a perfectly convincing diagram of the wrong
                // plant. Shave the arrow's tail off instead — a node name that
                // genuinely ends in '-' or '=' is a price worth paying.
                var from = s.slice(0, gt).replace(/[-=]+$/, '').trim();
                var tail = s.slice(gt + 1);
                var colon = tail.lastIndexOf(':');
                if (colon === -1) { bad.push(s); continue; }

                var to = tail.slice(0, colon).trim();
                var idx = parseInt(tail.slice(colon + 1).trim(), 10);
                if (!from || !to || !isFinite(idx) || idx < 1) { bad.push(s); continue; }

                out.push({ from: from, to: to, src: idx, seq: out.length, auto: false });
            }
            return out;
        }

        /**
         * The default topology, used when Links is blank.
         *
         * An engineer who has just dropped the symbol on a display has no
         * topology yet, and a blank rectangle teaches them nothing about what
         * the symbol is for. So: the first data source flows into a hub, and
         * every other source is a branch off that hub. It is a plausible shape,
         * it exercises every part of the layout, and the footer says out loud
         * that it is automatic — see the note in buildModel().
         */
        function autoLinks() {
            var out = [];
            if (!rows.length) { return out; }

            // The hub must not collide with a real tag name, or the very first
            // link would become a self-loop and be broken as a cycle.
            var hub = 'Distribution';
            var taken = {};
            var i;
            for (i = 0; i < rows.length; i++) { taken[key(nameOfRow(rows[i], i))] = true; }
            var guard = 0;
            while (taken[key(hub)] && guard < 20) { hub = hub + '*'; guard += 1; }

            out.push({ from: nameOfRow(rows[0], 0), to: hub, src: 1, seq: 0, auto: true });
            for (i = 1; i < rows.length; i++) {
                out.push({ from: hub, to: nameOfRow(rows[i], i), src: i + 1, seq: i, auto: true });
            }
            return out;
        }

        function nameOfRow(row, i) {
            return (row && row.label) ? String(row.label) : ('Source ' + (i + 1));
        }

        /** "Vent:#c8452f, Product:#3f9e6a" -> {key: colour}. */
        function parseNodeColors(spec) {
            var map = {};
            String(spec === null || spec === undefined ? '' : spec)
                .split(/[,\n;]/)
                .forEach(function (chunk) {
                    var s = chunk.trim();
                    if (!s) { return; }
                    var colon = s.lastIndexOf(':');
                    if (colon === -1) { return; }
                    var name = s.slice(0, colon).trim();
                    var col = s.slice(colon + 1).trim();
                    if (name && col) { map[key(lower(name))] = col; }
                });
            return map;
        }

        /** "Vent, Flare" -> set of lower-cased names. */
        function parseNameSet(spec) {
            var set = {};
            String(spec === null || spec === undefined ? '' : spec)
                .split(/[,\n;]/)
                .forEach(function (chunk) {
                    var s = chunk.trim();
                    if (s) { set[key(lower(s))] = true; }
                });
            return set;
        }

        /* ================================================================ *
         * Graph construction
         * ================================================================ */

        /**
         * Break every cycle by dropping its back edge.
         *
         * A cycle has no consistent ranking — "downstream of" stops being an
         * order — so a Sankey simply cannot be drawn from one. The choice is
         * between hanging, drawing something arbitrary and silent, or removing
         * the smallest thing that restores an order and saying which. This does
         * the third: a depth-first search over the links in the order the author
         * typed them, dropping any edge that points back at a node still open on
         * the stack, and returning their names for the footer.
         *
         * Iterative rather than recursive: the graph comes from a config string
         * and nothing stops somebody pasting a chain of two hundred links, which
         * on some of the browsers PI Vision still supports is close enough to
         * the stack limit to matter.
         */
        function breakCycles(nodes, links, dropped) {
            var WHITE = 0, GREY = 1, BLACK = 2;
            var color = [];
            var i;
            for (i = 0; i < nodes.length; i++) { color[i] = WHITE; }

            for (var start = 0; start < nodes.length; start++) {
                if (color[start] !== WHITE) { continue; }
                color[start] = GREY;
                var stack = [{ node: nodes[start], edge: 0 }];

                while (stack.length) {
                    var top = stack[stack.length - 1];
                    if (top.edge < top.node.out.length) {
                        var l = top.node.out[top.edge];
                        top.edge += 1;
                        if (l.dropped) { continue; }
                        var v = l.target;
                        if (color[v.index] === GREY) {
                            // Back edge: it closes a loop through nodes we are
                            // still inside. Drop it, name it, carry on.
                            l.dropped = true;
                            dropped.push(l.from + ' > ' + l.to);
                        } else if (color[v.index] === WHITE) {
                            color[v.index] = GREY;
                            stack.push({ node: v, edge: 0 });
                        }
                    } else {
                        color[top.node.index] = BLACK;
                        stack.pop();
                    }
                }
            }
        }

        /**
         * Rank = longest path from any source node.
         *
         * Longest path rather than shortest is what puts a node to the right of
         * EVERYTHING that feeds it: with shortest paths a node fed by both a
         * rank-0 and a rank-4 node would land at rank 1 and its inbound ribbon
         * would have to run backwards. Kahn's algorithm over the acyclic graph
         * gives it in one pass.
         */
        function rankNodes(nodes) {
            var i, j;
            var indeg = [];
            for (i = 0; i < nodes.length; i++) {
                indeg[i] = 0;
                nodes[i].rank = 0;
            }
            for (i = 0; i < nodes.length; i++) {
                for (j = 0; j < nodes[i].out.length; j++) {
                    if (!nodes[i].out[j].dropped) { indeg[nodes[i].out[j].target.index] += 1; }
                }
            }

            var queue = [];
            for (i = 0; i < nodes.length; i++) { if (indeg[i] === 0) { queue.push(nodes[i]); } }

            var head = 0;
            var guard = 0;
            var limit = nodes.length + 4;
            while (head < queue.length && guard < limit) {
                guard += 1;
                var u = queue[head];
                head += 1;
                for (j = 0; j < u.out.length; j++) {
                    var l = u.out[j];
                    if (l.dropped) { continue; }
                    var v = l.target;
                    if (v.rank < u.rank + 1) { v.rank = u.rank + 1; }
                    indeg[v.index] -= 1;
                    if (indeg[v.index] === 0) { queue.push(v); }
                }
            }
            // Anything still un-dequeued would mean a cycle survived, which
            // breakCycles() rules out. Leaving those at rank 0 is the safe
            // degenerate answer rather than looping forever.
        }

        /**
         * Connected components over the UNDIRECTED graph. Two independent
         * balances dropped on one symbol must not have their nodes interleaved
         * up the stacking axis — they are stacked one above the other instead,
         * which is what makes each of them readable.
         */
        function findComponents(nodes) {
            var i, j;
            var comp = 0;
            for (i = 0; i < nodes.length; i++) { nodes[i].comp = -1; }
            for (i = 0; i < nodes.length; i++) {
                if (nodes[i].comp !== -1) { continue; }
                var queue = [nodes[i]];
                nodes[i].comp = comp;
                var head = 0;
                while (head < queue.length) {
                    var u = queue[head];
                    head += 1;
                    for (j = 0; j < u.out.length; j++) {
                        var a = u.out[j];
                        if (!a.dropped && a.target.comp === -1) { a.target.comp = comp; queue.push(a.target); }
                    }
                    for (j = 0; j < u.in.length; j++) {
                        var b = u.in[j];
                        if (!b.dropped && b.source.comp === -1) { b.source.comp = comp; queue.push(b.source); }
                    }
                }
                comp += 1;
            }
            return comp;
        }

        /**
         * Order the nodes within each rank to reduce ribbon crossings.
         *
         * The barycentre heuristic (Sugiyama et al.): put each node next to the
         * average position of its neighbours in the adjacent rank, sweep down,
         * sweep up, repeat. It is the standard approach for layered graphs, it
         * is cheap, and two round trips get almost all of the benefit — crossing
         * minimisation is NP-hard, so an exact answer is not on the table and
         * would not be worth the milliseconds if it were.
         *
         * The component index stays the primary sort key throughout, so a sweep
         * can never shuffle two disconnected balances into each other.
         */
        function orderRanks(ranks) {
            var r, i;

            // Seed with the order the links were authored in: for a hand-written
            // topology that is usually already the intended reading order.
            for (r = 0; r < ranks.length; r++) {
                ranks[r].sort(function (a, b) {
                    return (a.comp - b.comp) || (a.seq - b.seq);
                });
                for (i = 0; i < ranks[r].length; i++) { ranks[r][i].pos = i; }
            }

            for (var pass = 0; pass < 2; pass++) {
                sweep(ranks, true);
                sweep(ranks, false);
            }
        }

        function sweep(ranks, forward) {
            var r, i;
            var from = forward ? 1 : ranks.length - 2;
            var to = forward ? ranks.length : -1;
            var step = forward ? 1 : -1;

            for (r = from; forward ? r < to : r > to; r += step) {
                var band = ranks[r];
                for (i = 0; i < band.length; i++) {
                    var node = band[i];
                    var list = forward ? node.in : node.out;
                    var sum = 0, n = 0;
                    for (var j = 0; j < list.length; j++) {
                        if (list[j].dropped) { continue; }
                        sum += (forward ? list[j].source.pos : list[j].target.pos);
                        n += 1;
                    }
                    // A node with no neighbour on that side has no opinion, so
                    // it holds its current place rather than being flung to 0.
                    node.bary = n ? sum / n : node.pos;
                }
                band.sort(function (a, b) {
                    return (a.comp - b.comp) || (a.bary - b.bary) || (a.pos - b.pos);
                });
                for (i = 0; i < band.length; i++) { band[i].pos = i; }
            }
        }

        /* ================================================================ *
         * Pure model — no DOM, no drawing decisions
         * ================================================================ */

        function buildModel(cfg) {
            var i, j;
            var badEntries = [];
            var entries = parseLinks(cfg.Links, badEntries);

            // AutoTopology only fills a VACUUM. If the author typed something —
            // even something malformed — inventing a diagram on top of it would
            // hide their mistake behind a picture that looks fine.
            var auto = false;
            if (!entries.length && !badEntries.length && cfg.AutoTopology !== false) {
                entries = autoLinks();
                auto = entries.length > 0;
            }

            var minLink = numIn(cfg.MinLinkValue, 0, 1e15, 0);
            var links = [];
            var nonPositive = [];   // named in the footer, never silently dropped
            var missingSrc = [];
            var noValue = 0;
            var belowMin = 0;
            var selfLoops = [];
            var badCount = 0;

            for (i = 0; i < entries.length; i++) {
                var e = entries[i];

                if (e.src > rows.length) {
                    // More links than data sources: the topology names a tag
                    // that was never dropped on the symbol.
                    missingSrc.push(e.from + ' > ' + e.to + ' (source ' + e.src + ')');
                    continue;
                }
                if (e.from === e.to) {
                    // A self-loop is a cycle of length one and has no honest
                    // ribbon; report it with the other broken links.
                    selfLoops.push(e.from + ' > ' + e.to);
                    continue;
                }

                var row = rows[e.src - 1];
                var v = PVX.data.statValue(row, cfg);
                if (v === null || v === undefined || !isFinite(v)) { noValue += 1; continue; }
                if (v <= 0) {
                    // A ribbon's thickness IS its value. There is no width that
                    // honestly represents minus four, so the stream leaves the
                    // diagram and enters the footer by name.
                    nonPositive.push(e.from + ' > ' + e.to);
                    continue;
                }
                if (v < minLink) { belowMin += 1; continue; }

                if (row.good === false) { badCount += 1; }
                links.push({
                    from: e.from, to: e.to, value: v, src: e.src,
                    units: row.units || '', good: row.good !== false,
                    error: row.errorDescription || '',
                    path: row.path || '', label: row.label || '',
                    seq: links.length, dropped: false
                });
            }

            // --- node set -------------------------------------------------
            var nodes = [];
            var byName = {};
            var nodeOf = function (name) {
                var k = key(name);
                if (!Object.prototype.hasOwnProperty.call(byName, k)) {
                    byName[k] = {
                        name: String(name), index: nodes.length, seq: nodes.length,
                        out: [], in: [], rank: 0, pos: 0, comp: 0, bary: 0,
                        inSum: 0, outSum: 0, value: 0, unbalanced: false, imbalance: 0
                    };
                    nodes.push(byName[k]);
                }
                return byName[k];
            };

            for (i = 0; i < links.length; i++) {
                var l = links[i];
                l.source = nodeOf(l.from);
                l.target = nodeOf(l.to);
                l.source.out.push(l);
                l.target.in.push(l);
            }

            // --- cycles, ranks, components, ordering ----------------------
            var cycleDrops = selfLoops.slice();
            breakCycles(nodes, links, cycleDrops);

            var live = [];
            for (i = 0; i < links.length; i++) { if (!links[i].dropped) { live.push(links[i]); } }

            rankNodes(nodes);
            var componentCount = findComponents(nodes);

            // --- node totals ----------------------------------------------
            var tol = numIn(cfg.BalanceTolerance, 0, 100, 2);
            var unbalanced = [];
            for (i = 0; i < nodes.length; i++) {
                var nd = nodes[i];
                nd.inSum = 0; nd.outSum = 0;
                for (j = 0; j < nd.in.length; j++) { if (!nd.in[j].dropped) { nd.inSum += nd.in[j].value; } }
                for (j = 0; j < nd.out.length; j++) { if (!nd.out[j].dropped) { nd.outSum += nd.out[j].value; } }
                // A node is as big as the larger of what enters and what leaves.
                // Sizing by inflow alone would draw a source as nothing.
                nd.value = Math.max(nd.inSum, nd.outSum);

                // Balance is only meaningful for a node that has both sides. A
                // source has no inflow and a sink no outflow, and calling either
                // of them "unbalanced" would cry wolf on every diagram.
                if (nd.inSum > 0 && nd.outSum > 0) {
                    nd.imbalance = Math.abs(nd.inSum - nd.outSum) / Math.max(nd.inSum, nd.outSum) * 100;
                    // Never under the automatic topology. "These two numbers
                    // should have been equal" is a claim about the PROCESS, and
                    // it is only true if somebody said these streams meet. The
                    // hub we invented balances by accident or not at all, and
                    // raising an alarm about it would be a false alarm about the
                    // engineer's plant.
                    if (cfg.ShowBalance !== false && !auto && nd.imbalance > tol) {
                        nd.unbalanced = true;
                        unbalanced.push(nd.name);
                    }
                }
            }

            // Drop nodes left with nothing attached (every link touching them
            // was broken or excluded); a zero-height bar is a smudge.
            var kept = [];
            for (i = 0; i < nodes.length; i++) {
                if (nodes[i].value > 0) { nodes[i].index = kept.length; kept.push(nodes[i]); }
            }

            var ranks = [];
            var maxRank = 0;
            for (i = 0; i < kept.length; i++) { if (kept[i].rank > maxRank) { maxRank = kept[i].rank; } }
            for (i = 0; i <= maxRank; i++) { ranks.push([]); }
            for (i = 0; i < kept.length; i++) { ranks[kept[i].rank].push(kept[i]); }
            // A rank can end up empty when every node at that depth was dropped.
            var dense = [];
            for (i = 0; i < ranks.length; i++) { if (ranks[i].length) { dense.push(ranks[i]); } }
            for (i = 0; i < dense.length; i++) {
                for (j = 0; j < dense[i].length; j++) { dense[i][j].rank = i; }
            }
            ranks = dense;

            orderRanks(ranks);

            // --- notes ----------------------------------------------------
            var notes = [];
            if (auto) {
                // Every frame, not once: an invented topology that reads as an
                // authored one is a lie about the plant.
                notes.push('Automatic layout — no links configured');
            }
            if (badEntries.length) {
                notes.push('Malformed link' + (badEntries.length === 1 ? '' : 's') + ': ' +
                    nameList(badEntries, 2));
            }
            if (cycleDrops.length) {
                notes.push('Cycle broken, dropped: ' + nameList(cycleDrops, 2));
            }
            if (nonPositive.length) {
                notes.push('Not drawable (zero or negative): ' + nameList(nonPositive, 3));
            }
            if (missingSrc.length) {
                notes.push('No such data source: ' + nameList(missingSrc, 2));
            }
            if (noValue) {
                notes.push(noValue + (noValue === 1 ? ' link has no ' : ' links have no ') +
                    PVX.config.statLabel(cfg).toLowerCase());
            }
            if (belowMin) {
                notes.push(belowMin + (belowMin === 1 ? ' link' : ' links') + ' below minimum');
            }
            if (unbalanced.length) {
                notes.push('Unbalanced: ' + nameList(unbalanced, 3));
            }
            if (componentCount > 1 && live.length) {
                notes.push(componentCount + ' separate flows');
            }

            // --- empty states ----------------------------------------------
            var headline = '', detail = '';
            if (!live.length || !ranks.length) {
                if (!rows.length && !entries.length) {
                    headline = 'No data sources';
                    detail = 'Drop attributes on this symbol, then describe the flow in Links.';
                } else if (badEntries.length && !links.length) {
                    headline = 'Links could not be read';
                    detail = 'Use  From > To : sourceIndex  separated by |';
                } else if (nonPositive.length && !live.length) {
                    headline = 'No positive flows';
                    detail = 'A ribbon width cannot represent a zero or negative value.';
                } else if (!entries.length) {
                    headline = 'No flow configured';
                    detail = 'Describe the topology in Links, or switch automatic layout on.';
                } else {
                    headline = 'Nothing to draw';
                    detail = 'No link survived with a usable ' + PVX.config.statLabel(cfg).toLowerCase() + '.';
                }
            }

            return {
                nodes: kept, links: live, ranks: ranks,
                auto: auto, notes: notes, badCount: badCount,
                sources: rows.length, linkCount: live.length,
                requested: entries.length,
                empty: !live.length || !ranks.length,
                headline: headline, detail: detail
            };
        }

        /** Name the offenders — a bare count does not let anybody act on it. */
        function nameList(list, shown) {
            var take = Math.min(list.length, shown);
            var out = [];
            for (var i = 0; i < take; i++) { out.push(list[i]); }
            var more = list.length - take;
            return out.join(', ') + (more ? ' +' + more + ' more' : '');
        }

        /* ================================================================ *
         * Geometry
         * ================================================================ *
         * Everything is computed in an ALONG / ACROSS frame: `along` runs in the
         * direction of flow (rank to rank) and `across` is the stacking axis.
         * Horizontal orientation maps along->x and across->y; vertical swaps
         * them. One set of layout maths, two orientations, and no chance of the
         * two drifting apart.
         */

        function layoutGraph(model, cfg, W, H, o) {
            var i, j, r;
            var horiz = o.horiz;
            var font = o.font;
            var pad = 4;

            var alongMax = horiz ? W : H;
            var acrossMax = horiz ? H : W;

            var a0 = pad, a1 = alongMax - pad;
            var c0 = pad, c1 = acrossMax - pad;
            // The absolute frame limits on the stacking axis, kept because the
            // outermost node in a rank may put its label in the clearance that
            // c0/c1 are about to give away to the interior labels.
            var cTop = c0, cBot = c1;
            var ranks = model.ranks;
            var R = ranks.length;

            // ---- reserve room for the outside labels ---------------------
            var lead = 0, trail = 0;
            if (o.showLabels && o.outside) {
                if (horiz) {
                    // The label runs along the flow axis, so what it needs is a
                    // WIDTH — of the widest NAME in the rank, and of the widest
                    // VALUE under it. Sizing on the name alone reserved enough
                    // room for "Feed" and then truncated "122.4 klb/h" beneath
                    // it, which is the one line on the label that has to be
                    // readable in full.
                    var widest = function (band) {
                        var px = 0;
                        for (var b = 0; b < band.length; b++) {
                            px = Math.max(px, o.textPx(band[b].name, font));
                            if (o.showValues) {
                                px = Math.max(px, o.textPx(
                                    valueText(band[b].value, unitsOf(band[b]), cfg), font * 0.9));
                            }
                        }
                        return px;
                    };
                    var firstPx = widest(ranks[0]);
                    var lastPx = widest(ranks[R - 1]);
                    // Never more than a quarter of the frame each: the ribbons
                    // are the data and the labels are the annotation.
                    lead = Math.min(firstPx + 6, alongMax * 0.26);
                    trail = Math.min(lastPx + 6, alongMax * 0.26);
                } else {
                    // Vertical: the label sits above/below, so it costs a text
                    // HEIGHT, not a width.
                    lead = font * (o.showValues ? 2.6 : 1.5);
                    trail = lead;
                }
                a0 += lead;
                a1 -= trail;
            }

            // Interior ranks carry their label just before the node on the
            // stacking axis (there is no margin to use in the middle of the
            // diagram), so that edge needs a line of clearance — two when the
            // value is shown underneath the name.
            if (o.showLabels && R > 2) { c0 += font * (o.showValues ? 2.35 : 1.25); }

            var alongSpan = a1 - a0;
            var acrossSpan = c1 - c0;
            if (!(alongSpan > 8) || !(acrossSpan > 6)) {
                // Labels ate the frame. The ribbons matter more, so take it back.
                a0 = pad; a1 = alongMax - pad; c0 = pad; c1 = acrossMax - pad;
                alongSpan = a1 - a0; acrossSpan = c1 - c0;
                o.showLabels = false;
            }
            if (!(alongSpan > 2) || !(acrossSpan > 2)) { return null; }

            // ---- rank positions along the flow axis ----------------------
            // At the smallest sizes the node bars are not drawn, and a 14px
            // node width would then leave 14px of blank paper between every
            // pair of ribbons — the diagram would read as disconnected blobs
            // rather than as a flow. Shrink it to a hairline so the ribbons
            // meet.
            var nw = o.tiny ? 1.5 : numIn(cfg.NodeWidth, 1, 80, 14);
            // Node bars must never eat more than half the run, or there is no
            // room left for the ribbons that carry the actual information.
            nw = Math.max(1, Math.min(nw, alongSpan / (R * 2.2)));
            var gap = R > 1 ? (alongSpan - R * nw) / (R - 1) : 0;

            for (r = 0; r < R; r++) {
                var ra = R > 1 ? a0 + r * (nw + gap) : a0 + (alongSpan - nw) / 2;
                for (i = 0; i < ranks[r].length; i++) {
                    ranks[r][i].a0 = ra;
                    ranks[r][i].a1 = ra + nw;
                }
            }

            // ---- node sizes ----------------------------------------------
            var maxCount = 1;
            for (r = 0; r < R; r++) { maxCount = Math.max(maxCount, ranks[r].length); }

            var nodePad = numIn(cfg.NodePadding, 0, 200, 12);
            if (maxCount > 1) {
                // Padding is a nicety; the ribbons are the message. Cap it so
                // the gaps can never take more than 55% of the stacking axis.
                nodePad = Math.min(nodePad, (acrossSpan * 0.55) / (maxCount - 1));
            }
            nodePad = Math.max(0, nodePad);

            // One scale for the whole diagram — value to pixels. It has to be
            // the tightest of the ranks, otherwise the busiest rank overflows.
            var ky = Infinity;
            for (r = 0; r < R; r++) {
                var total = 0;
                for (i = 0; i < ranks[r].length; i++) { total += ranks[r][i].value; }
                if (!(total > 0)) { continue; }
                var room = acrossSpan - (ranks[r].length - 1) * nodePad;
                if (room > 0) { ky = Math.min(ky, room / total); }
            }
            if (!isFinite(ky) || !(ky > 0)) { return null; }

            // ---- stack each rank -----------------------------------------
            for (r = 0; r < R; r++) {
                var band = ranks[r];
                var stackH = (band.length - 1) * nodePad;
                for (i = 0; i < band.length; i++) { stackH += band[i].value * ky; }
                // Centred rather than top-aligned: a Sankey read as a balance is
                // easier to follow when the trunk runs through the middle.
                var cur = c0 + Math.max(0, (acrossSpan - stackH) / 2);
                for (i = 0; i < band.length; i++) {
                    var nd = band[i];
                    nd.h = Math.max(1, nd.value * ky);
                    nd.c0 = PVX.util.clamp(cur, c0, Math.max(c0, c1 - nd.h));
                    nd.c1 = nd.c0 + nd.h;
                    cur = nd.c1 + nodePad;
                }

                // The strip of the stacking axis this node's LABEL may use: its
                // own extent plus half of the gap to each neighbour. A thin node
                // in a busy rank gets a thin strip, which is what stops one
                // node's value line from being printed over the next one's name.
                // The outermost nodes get the whole way to the frame, including
                // the clearance reserved above for the interior labels.
                for (i = 0; i < band.length; i++) {
                    band[i].band0 = i > 0 ? (band[i - 1].c1 + band[i].c0) / 2 : cTop;
                    band[i].band1 = i < band.length - 1 ? (band[i].c1 + band[i + 1].c0) / 2 : cBot;
                }
            }

            // ---- link positions inside each node -------------------------
            // Ordering the ends to match the neighbouring rank is what stops
            // ribbons from crossing each other inside a single node — the last
            // and cheapest crossing reduction there is.
            for (i = 0; i < model.nodes.length; i++) {
                var node = model.nodes[i];

                node.out.sort(function (p, q) {
                    return (p.target.pos - q.target.pos) || (p.target.c0 - q.target.c0) || (p.seq - q.seq);
                });
                var oy = node.c0;
                for (j = 0; j < node.out.length; j++) {
                    var lo = node.out[j];
                    if (lo.dropped) { continue; }
                    lo.w = Math.max(0.7, lo.value * ky);
                    lo.sc = oy;
                    oy += lo.w;
                }

                node.in.sort(function (p, q) {
                    return (p.source.pos - q.source.pos) || (p.source.c0 - q.source.c0) || (p.seq - q.seq);
                });
                var iy = node.c0;
                for (j = 0; j < node.in.length; j++) {
                    var li = node.in[j];
                    if (li.dropped) { continue; }
                    li.w = Math.max(0.7, li.value * ky);
                    li.tc = iy;
                    iy += li.w;
                }
            }

            // ---- clamp every ribbon into the plot ------------------------
            // Sub-pixel node heights and the 0.7px minimum ribbon can together
            // push the last stripe a hair past the edge, where the host's
            // overflow:hidden would slice it. Clamp rather than clip.
            for (i = 0; i < model.links.length; i++) {
                var l = model.links[i];
                l.sc = PVX.util.clamp(l.sc, c0, Math.max(c0, c1 - l.w));
                l.tc = PVX.util.clamp(l.tc, c0, Math.max(c0, c1 - l.w));
            }

            return { a0: a0, a1: a1, c0: c0, c1: c1, nodeWidth: nw, gap: gap, ky: ky, ranks: R };
        }

        /* ================================================================ *
         * Colour
         * ================================================================ */

        /** The colour the symbol is actually painted on, transparent included. */
        function surfaceOf(t) {
            if (t.surface && t.surface !== 'transparent') { return t.surface; }
            return t.dark ? '#22262b' : '#ffffff';
        }

        function nodeColor(node, cfg, t, o) {
            var k = key(lower(node.name));
            // An explicit colour always wins: it is the one thing the author
            // said out loud about this node.
            if (Object.prototype.hasOwnProperty.call(o.nodeColors, k)) { return o.nodeColors[k]; }
            if (Object.prototype.hasOwnProperty.call(o.lossNodes, k)) { return t.status.alarm; }
            if (cfg.ColorMode === 'single') {
                // In single-colour mode the ribbons carry the one colour, so the
                // bars step back to a neutral that frames them.
                return PVX.color.mix(surfaceOf(t), t.text, 0.45);
            }
            return PVX.color.categorical[node.index % PVX.color.categorical.length];
        }

        function linkColors(l, cfg, t, o) {
            var single = cfg.SingleColor || '#3b82c4';
            switch (cfg.ColorMode) {
                case 'link':
                    // Gradient: the stream visibly becomes what it turns into.
                    return { from: nodeColor(l.source, cfg, t, o), to: nodeColor(l.target, cfg, t, o) };
                case 'single':
                    return { from: single, to: single };
                case 'threshold':
                    // Falls back to the flat colour when thresholds are off, so
                    // the mode never silently paints everything one band.
                    var band = cfg.UseThresholds
                        ? PVX.thresholds.colorFor(cfg.Thresholds, l.value, single)
                        : single;
                    return { from: band, to: band };
                case 'node':
                default:
                    // Source colour, so a stream can be followed with the eye
                    // from where it came from all the way to where it ends up.
                    var c = nodeColor(l.source, cfg, t, o);
                    return { from: c, to: c };
            }
        }

        /**
         * Hatched fill for bad quality. A ribbon whose width came from an
         * untrusted reading still occupies its share of the balance, so it keeps
         * its place; but a solid ribbon reads as a real measurement and this
         * must not. One pattern per colour per render; ids are unique so several
         * instances of the symbol on one display cannot collide.
         */
        function hatchFor(defs, cache, fill) {
            if (cache[key(fill)]) { return cache[key(fill)]; }
            var id = PVX.util.uid('pvxskhatch');
            var p = PVX.svg.el('pattern', {
                id: id, width: 6, height: 6,
                patternUnits: 'userSpaceOnUse',
                patternTransform: 'rotate(45)'
            }, defs);
            PVX.svg.el('rect', { x: 0, y: 0, width: 6, height: 6, fill: fill, 'fill-opacity': 0.2 }, p);
            PVX.svg.el('rect', { x: 0, y: 0, width: 3, height: 6, fill: fill, 'fill-opacity': 0.95 }, p);
            cache[key(fill)] = 'url(#' + id + ')';
            return cache[key(fill)];
        }

        /* ================================================================ *
         * Text
         * ================================================================ */

        /** Cheap pre-truncation estimate; fitTextTo() does the real work. */
        function textPx(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.58;
        }

        function truncate(s, maxPx, fontPx) {
            var str = String(s === null || s === undefined ? '' : s);
            var max = Math.floor(maxPx / (fontPx * 0.58));
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '…'; }
            return str.slice(0, max - 1) + '…';
        }

        /**
         * Trim an already-drawn <text> until getComputedTextLength() reports it
         * fits `maxPx`; empty it if even one glyph is too much.
         *
         * Why measure rather than trust the estimate: a first-rank label is
         * end-anchored against the left edge of the symbol, so an estimate that
         * runs narrow — and mixed-case plant names like "Feedwater Pump B"
         * average well above 0.58em — pushes the START of the string off-canvas,
         * where overflow:hidden chops the first glyph instead of ellipsising.
         * No clamp saves it after the fact; the text has to be short enough.
         * The caller passes text already cut by the estimate, so the common case
         * measures once and returns.
         */
        function fitTextTo(node, maxPx) {
            if (!node || !node.getComputedTextLength) { return true; }
            if (!(maxPx > 0)) { node.textContent = ''; return false; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            for (var guard = 0; guard < 8; guard++) {
                var w = measure();
                if (!(w > maxPx)) { return node.textContent !== ''; }
                var cur = node.textContent || '';
                var core = cur.charAt(cur.length - 1) === '…' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return false; }
                // -1 leaves room for the ellipsis; the min() guarantees the
                // string shrinks every pass even when the ratio rounds up.
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return false; }
                node.textContent = core.slice(0, keep) + '…';
            }
            if (measure() > maxPx) { node.textContent = ''; return false; }
            return true;
        }

        function valueText(v, units, cfg) {
            var s = PVX.fmt.number(v, PVX.config.numberOpts(cfg));
            if (cfg.ShowUnits && units) { s += ' ' + units; }
            return s;
        }

        /** Units only belong in the header when every link agrees on them. */
        function commonUnits(cfg, model) {
            if (!cfg.ShowUnits) { return ''; }
            var u = null;
            for (var i = 0; i < model.links.length; i++) {
                var iu = model.links[i].units || '';
                if (u === null) { u = iu; }
                else if (u !== iu) { return ''; }
            }
            return u ? ' · ' + u : '';
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            // Self-heal a config saved by an older build or edited by hand.
            // Only writes when something actually differs, so this cannot loop
            // with PI Vision's own change detection.
            PVX.config.syncStatColumns(cfg);

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            // Chrome decisions are about the SYMBOL box, not the drawing host —
            // the host is already smaller by however much chrome is showing, so
            // deciding from it would oscillate between two layouts.
            var symW = (c.node && c.node.clientWidth) || c.width;
            var symH = (c.node && c.node.clientHeight) || c.height;
            var compact = symW < 240 || symH < 160;   // no labels, no values
            var tiny = symW < 140 || symH < 100;      // ribbons alone

            var W = Math.max(20, c.width);
            var H = Math.max(16, c.height);

            var svgRoot = host.querySelector('svg.pvx-sk-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-sk-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var model = buildModel(cfg);

            // ---- chrome ---------------------------------------------------
            scope.pvx.title = cfg.Title || 'Flow';
            scope.pvx.subtitle = PVX.config.statLabel(cfg) + commonUnits(cfg, model);
            scope.pvx.showHeader = !compact && !!cfg.ShowLabel;
            scope.pvx.error = model.badCount
                ? (model.badCount + (model.badCount === 1 ? ' flow reports' : ' flows report') + ' bad quality')
                : '';

            if (model.empty) {
                scope.pvx.note = model.notes.join(' · ');
                scope.pvx.count = '';
                scope.pvx.showFooter = !compact && !!scope.pvx.note;
                emptyState(svgRoot, W, H, t, model.headline, model.detail);
                digest();
                return;
            }

            var drawn = drawSankey(svgRoot, W, H, cfg, t, model, compact, tiny);

            var notes = model.notes.slice();
            if (!drawn) {
                notes.push('Too small to lay out');
            }
            scope.pvx.note = notes.join(' · ');
            scope.pvx.count = model.linkCount +
                (model.linkCount === 1 ? ' flow · ' : ' flows · ') +
                model.nodes.length + (model.nodes.length === 1 ? ' node' : ' nodes');
            scope.pvx.showFooter = !compact && !!(scope.pvx.note || scope.pvx.count);

            digest();
        }

        function drawSankey(svgRoot, W, H, cfg, t, model, compact, tiny) {
            var i;
            var horiz = cfg.Orientation !== 'vertical';
            var defs = PVX.svg.el('defs', null, svgRoot);

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 26), 8, 12);
            var showLabels = !compact && !tiny && cfg.ShowNodeLabels !== false;
            var showValues = showLabels && cfg.ShowNodeValues !== false;

            var o = {
                horiz: horiz,
                font: font,
                showLabels: showLabels,
                showValues: showValues,
                tiny: tiny,
                outside: (cfg.LabelPosition || 'outside') !== 'inside',
                textPx: textPx,
                nodeColors: parseNodeColors(cfg.NodeColors),
                lossNodes: parseNameSet(cfg.HighlightLoss),
                hatch: {},
                defs: defs,
                surface: surfaceOf(t)
            };

            var box = layoutGraph(model, cfg, W, H, o);
            if (!box) { return null; }
            // layoutGraph may have surrendered the label margins to the ribbons.
            showLabels = o.showLabels;
            showValues = showValues && showLabels;

            // Along/across -> screen. One place, so the two orientations can
            // never drift apart.
            var pt = horiz
                ? function (a, c) { return a.toFixed(2) + ' ' + c.toFixed(2); }
                : function (a, c) { return c.toFixed(2) + ' ' + a.toFixed(2); };
            var px = horiz ? function (a, c) { return a; } : function (a, c) { return c; };
            var py = horiz ? function (a, c) { return c; } : function (a, c) { return a; };

            var opacity = numIn(cfg.LinkOpacity, 0.05, 1, 0.45);
            var curv = numIn(cfg.LinkCurvature, 0, 1, 0.5);

            // ---- ribbons --------------------------------------------------
            // Drawn before the nodes so a node bar always caps its own ribbons
            // rather than being buried under them.
            var linksG = PVX.svg.el('g', { 'class': 'pvx-sk-links' }, svgRoot);
            for (i = 0; i < model.links.length; i++) {
                drawRibbon(linksG, model.links[i], cfg, t, o, pt, opacity, curv, tiny);
            }

            // ---- nodes ----------------------------------------------------
            if (!tiny) {
                var nodesG = PVX.svg.el('g', { 'class': 'pvx-sk-nodes' }, svgRoot);
                for (i = 0; i < model.nodes.length; i++) {
                    drawNode(nodesG, model.nodes[i], cfg, t, o, px, py, box, compact);
                }
            }

            // ---- labels ---------------------------------------------------
            // Last, so nothing can be drawn over a name.
            if (showLabels) {
                var labelsG = PVX.svg.el('g', { 'class': 'pvx-sk-labels' }, svgRoot);
                for (i = 0; i < model.nodes.length; i++) {
                    drawNodeLabel(labelsG, model.nodes[i], cfg, t, o, box, W, H, showValues);
                }
            }

            if (!compact && !tiny && cfg.ShowLinkValues) {
                var lvG = PVX.svg.el('g', { 'class': 'pvx-sk-linkvalues' }, svgRoot);
                for (i = 0; i < model.links.length; i++) {
                    drawLinkValue(lvG, model.links[i], cfg, t, o, px, py, curv);
                }
            }

            return { nodes: model.nodes.length, links: model.links.length };
        }

        /**
         * One ribbon. The top edge runs source -> target as a cubic Bezier, the
         * bottom edge runs back target -> source offset by the flow's thickness,
         * and the two are closed into a filled band. Both edges share the same
         * control-point abscissae so the band keeps a constant thickness all the
         * way across — which is the whole point: the thickness IS the value.
         */
        function drawRibbon(parent, l, cfg, t, o, pt, opacity, curv, tiny) {
            var sa = l.source.a1, ta = l.target.a0;
            var d = ta - sa;
            var k0 = sa + d * curv;
            var k1 = ta - d * curv;
            var s0 = l.sc, s1 = l.sc + l.w;
            var t0 = l.tc, t1 = l.tc + l.w;

            var path = 'M' + pt(sa, s0) +
                ' C' + pt(k0, s0) + ',' + pt(k1, t0) + ',' + pt(ta, t0) +
                ' L' + pt(ta, t1) +
                ' C' + pt(k1, t1) + ',' + pt(k0, s1) + ',' + pt(sa, s1) + ' Z';

            var cols = linkColors(l, cfg, t, o);
            var fill;
            if (cfg.ColorMode === 'link' && cols.from !== cols.to) {
                fill = 'url(#' + gradientFor(o, sa, s0 + l.w / 2, ta, t0 + l.w / 2, cols, o.horiz) + ')';
            } else {
                fill = cols.from;
            }
            if (!l.good) { fill = hatchFor(o.defs, o.hatch, cols.from); }

            var g = PVX.svg.el('g', { 'class': 'pvx-sk-link' }, parent);
            PVX.svg.el('path', {
                d: path,
                fill: fill,
                'fill-opacity': l.good ? opacity : Math.min(1, opacity + 0.35),
                stroke: 'none'
            }, g);

            if (tiny) { return; }

            // The exact numbers live in a <title>: the diagram is a proportion,
            // the tooltip is the measurement.
            var tip = PVX.svg.el('title', null, g);
            tip.textContent = l.from + ' → ' + l.to + ' — ' +
                PVX.fmt.number(l.value, PVX.config.numberOpts(cfg)) +
                (l.units ? ' ' + l.units : '') +
                (l.label ? '\n' + l.label : '') +
                (l.good ? '' : '\n BAD QUALITY' + (l.error ? ': ' + l.error : '')) +
                (l.path ? '\n' + l.path : '');
        }

        /**
         * A linearGradient in user space between the two ribbon ends. One per
         * ribbon, with a unique id, so two instances of the symbol on the same
         * display cannot steal each other's colours.
         */
        function gradientFor(o, sa, sc, ta, tc, cols, horiz) {
            var id = PVX.util.uid('pvxskgrad');
            var g = PVX.svg.el('linearGradient', {
                id: id,
                gradientUnits: 'userSpaceOnUse',
                x1: (horiz ? sa : sc).toFixed(2), y1: (horiz ? sc : sa).toFixed(2),
                x2: (horiz ? ta : tc).toFixed(2), y2: (horiz ? tc : ta).toFixed(2)
            }, o.defs);
            PVX.svg.el('stop', { offset: '0', 'stop-color': cols.from }, g);
            PVX.svg.el('stop', { offset: '1', 'stop-color': cols.to }, g);
            return id;
        }

        function drawNode(parent, nd, cfg, t, o, px, py, box, compact) {
            var x = Math.min(px(nd.a0, nd.c0), px(nd.a1, nd.c1));
            var y = Math.min(py(nd.a0, nd.c0), py(nd.a1, nd.c1));
            var w = Math.abs(px(nd.a1, nd.c1) - px(nd.a0, nd.c0));
            var h = Math.abs(py(nd.a1, nd.c1) - py(nd.a0, nd.c0));

            var col = nodeColor(nd, cfg, t, o);
            var g = PVX.svg.el('g', { 'class': 'pvx-sk-node' }, parent);

            PVX.svg.el('rect', {
                x: x.toFixed(2), y: y.toFixed(2),
                width: Math.max(1, w).toFixed(2), height: Math.max(1, h).toFixed(2),
                rx: Math.min(2, w / 2, h / 2).toFixed(1),
                fill: col,
                // An unbalanced node is outlined in the alarm colour: it is the
                // one thing on the diagram that means somebody has to go and
                // look at something.
                stroke: nd.unbalanced ? t.status.alarm : 'none',
                'stroke-width': nd.unbalanced ? 1.5 : null
            }, g);

            var tip = PVX.svg.el('title', null, g);
            tip.textContent = nd.name +
                '\nIn: ' + (nd.inSum > 0 ? PVX.fmt.number(nd.inSum, PVX.config.numberOpts(cfg)) : '—') +
                '   Out: ' + (nd.outSum > 0 ? PVX.fmt.number(nd.outSum, PVX.config.numberOpts(cfg)) : '—') +
                (nd.inSum > 0 && nd.outSum > 0
                    ? '\nImbalance: ' + nd.imbalance.toFixed(1) + '%' +
                      (nd.unbalanced ? '  (over tolerance)' : '')
                    : '');

            // A marker as well as the outline: a 1.5px stroke on a 14px bar is
            // easy to miss on a wall display at three metres. It goes above the
            // node, or below when the node is already against the top edge —
            // a dot half outside the frame flags nothing.
            if (nd.unbalanced && !compact) {
                // Placed in along/across terms, not screen terms, so it lands
                // beside the bar in both orientations: above it when the flow
                // runs left to right, left of it when it runs top to bottom.
                var mr = 2.6;
                var ma = (nd.a0 + nd.a1) / 2;
                var mc = nd.c0 - mr - 1;
                var scr = { x: px(ma, mc), y: py(ma, mc) };
                // Against the frame edge there is no room before the bar, so the
                // flag goes after it instead; half a dot outside the symbol
                // flags nothing.
                if (Math.min(scr.x, scr.y) - mr < 1) {
                    mc = nd.c1 + mr + 1;
                    scr = { x: px(ma, mc), y: py(ma, mc) };
                }
                PVX.svg.el('circle', {
                    cx: scr.x.toFixed(2), cy: scr.y.toFixed(2),
                    r: mr.toFixed(1),
                    fill: t.status.alarm,
                    'class': 'pvx-sk-flag'
                }, g);
            }
        }

        /**
         * Node labels.
         *
         *   outside  — first rank before the diagram, last rank after it, so the
         *              two ends read like the row headings of a table.
         *   inside   — hard against the node bar, inside the plot, for a symbol
         *              too narrow to spend margins on.
         *   interior — always just before the node on the stacking axis (above
         *              it, horizontally), because there is no margin to use in
         *              the middle of the diagram.
         *
         * Every string is measured, never estimated: see fitTextTo.
         */
        function drawNodeLabel(parent, nd, cfg, t, o, box, W, H, showValues) {
            var horiz = o.horiz;
            var font = o.font;
            var first = nd.rank === 0;
            var last = nd.rank === box.ranks - 1;
            var edge = first || last;

            // The strip of the stacking axis this node owns (see layoutGraph).
            // Everything below is decided against it, because the failure mode
            // that actually happens in the field is not a label running off the
            // frame — it is a thin node's value line landing on the NEXT node's
            // name, which reads as one wrong number attached to one wrong tag.
            var bandPx = Math.max(0, nd.band1 - nd.band0);

            var lines = showValues ? 2 : 1;
            var x, yName, yValue, anchor, budget;

            if (horiz && edge) {
                // Names run along the flow axis, so the two lines stack ACROSS
                // it and must fit inside this node's strip.
                if (bandPx < font * 1.05) { return; }
                if (lines === 2 && bandPx < font * 2.25) { lines = 1; }
                var half = font * 0.58 * lines;
                var mid = PVX.util.clamp((nd.c0 + nd.c1) / 2,
                    nd.band0 + half, Math.max(nd.band0 + half, nd.band1 - half));
                yName = lines === 2 ? mid - font * 0.56 : mid;
                yValue = mid + font * 0.56;

                if (o.outside) {
                    anchor = first ? 'end' : 'start';
                    x = first ? nd.a0 - 5 : nd.a1 + 5;
                    budget = first ? Math.max(0, x - 2) : Math.max(0, W - 2 - x);
                } else {
                    // 'inside': tucked against the bar, pointing into the plot.
                    anchor = first ? 'start' : 'end';
                    x = first ? nd.a1 + 4 : nd.a0 - 4;
                    budget = first ? Math.max(0, box.a1 - x) : Math.max(0, x - box.a0);
                }
            } else if (horiz) {
                // Interior rank: stacked above the node bar. There is no margin
                // in the middle of a Sankey to put a label in, so the only room
                // available is the gap to the node above.
                var above = nd.c0 - nd.band0 - 3;
                // Only when there is room for the WHOLE block. A tall node
                // pressed against the top of the frame has room for one line
                // and would drop its value; the fallback below has the node's
                // full strip to work with and can keep both.
                if (above >= font * (lines === 2 ? 2.3 : 1.05)) {
                    anchor = 'middle';
                    x = (nd.a0 + nd.a1) / 2;
                    yValue = nd.c0 - 4;
                    yName = lines === 2 ? yValue - font * 1.08 : yValue;
                    // Centre-anchored text spills past BOTH sides at once, and
                    // what it would spill onto is the label of the rank next
                    // door — so the real budget is the rank pitch, not the
                    // frame.
                    budget = Math.max(0, Math.min(
                        Math.min(x - 2, W - 2 - x) * 2,
                        (box.gap + box.nodeWidth) * 0.95));
                } else {
                    // No room above — a crowded interior rank, which is exactly
                    // where the unnamed node is most confusing. Fall back to the
                    // classic placement hard against the node, reading into the
                    // gap before the next rank. It sits over ribbons, which is
                    // what the halo is for.
                    if (bandPx < font * 1.05) { return; }
                    if (lines === 2 && bandPx < font * 2.25) { lines = 1; }
                    var h2 = font * 0.58 * lines;
                    var m2 = PVX.util.clamp((nd.c0 + nd.c1) / 2,
                        nd.band0 + h2, Math.max(nd.band0 + h2, nd.band1 - h2));
                    anchor = 'start';
                    x = nd.a1 + 4;
                    yName = lines === 2 ? m2 - font * 0.56 : m2;
                    yValue = m2 + font * 0.56;
                    budget = Math.max(0, Math.min(box.gap - 8, W - 2 - x));
                }
            } else if (edge) {
                // Vertical flow: the block sits above the first rank and below
                // the last, and its WIDTH is what the node's strip bounds.
                anchor = 'middle';
                x = (nd.c0 + nd.c1) / 2;
                // Outside: the last rank reads downwards. Inside: the first
                // rank does, because its block has to fall INTO the diagram.
                if (o.outside ? last : first) {
                    yName = nd.a1 + 4 + font * 0.6;
                    yValue = yName + font * 1.08;
                } else {
                    yValue = nd.a0 - 4;
                    yName = lines === 2 ? yValue - font * 1.08 : yValue;
                }
                budget = Math.max(0, Math.min(Math.min(x - 2, W - 2 - x) * 2, bandPx));
            } else {
                // Interior rank, vertical flow: to the left of the node bar,
                // bounded by the gap to the node on that side.
                var leftRoom = nd.c0 - nd.band0 - 4;
                // Three glyphs' worth or it is not a name, it is an ellipsis
                // with a letter in front of it — take the fallback instead.
                if (leftRoom > font * 3) {
                    anchor = 'end';
                    x = nd.c0 - 4;
                    yName = (nd.a0 + nd.a1) / 2 - (lines === 2 ? font * 0.56 : 0);
                    yValue = (nd.a0 + nd.a1) / 2 + font * 0.56;
                    budget = leftRoom;
                } else {
                    // Crowded rank: read downstream of the bar instead, into the
                    // gap before the next rank.
                    anchor = 'middle';
                    x = (nd.c0 + nd.c1) / 2;
                    yName = nd.a1 + 4 + font * 0.6;
                    yValue = yName + font * 1.08;
                    budget = Math.max(0, Math.min(Math.min(x - 2, W - 2 - x) * 2, bandPx));
                }
            }

            if (!(budget > font * 1.2)) { return; }
            if (yName - font * 0.6 < 1 || yName + font * 0.6 > H - 1) { return; }

            var halo = o.surface;
            var nameNode = PVX.svg.text(parent, x.toFixed(2), yName.toFixed(2),
                truncate(nd.name, budget, font), {
                    'class': 'pvx-svg-label pvx-sk-label',
                    'text-anchor': anchor,
                    'font-size': font,
                    'font-weight': '600',
                    fill: t.text,
                    // Labels sit over ribbons; a halo in the surface colour
                    // keeps them legible without a background box.
                    stroke: halo, 'stroke-width': 2.6, 'stroke-linejoin': 'round'
                });
            if (!fitTextTo(nameNode, budget)) {
                parent.removeChild(nameNode);
                return;
            }
            PVX.svg.el('title', null, nameNode).textContent = nd.name;

            if (lines < 2) { return; }
            if (yValue + font * 0.6 > H - 1 || yValue - font * 0.6 < 1) { return; }

            var valNode = PVX.svg.text(parent, x.toFixed(2), yValue.toFixed(2),
                truncate(valueText(nd.value, unitsOf(nd), cfg), budget, font * 0.9), {
                    'class': 'pvx-svg-value pvx-num pvx-sk-value',
                    'text-anchor': anchor,
                    'font-size': (font * 0.9).toFixed(1),
                    fill: nd.unbalanced ? t.status.alarm : t.textMuted,
                    stroke: halo, 'stroke-width': 2.4, 'stroke-linejoin': 'round'
                });
            if (!fitTextTo(valNode, budget)) { parent.removeChild(valNode); }
        }

        /** Units for a node — only when every flow touching it agrees. */
        function unitsOf(nd) {
            var u = null;
            var i;
            var scan = function (list) {
                for (i = 0; i < list.length; i++) {
                    if (list[i].dropped) { continue; }
                    var iu = list[i].units || '';
                    if (u === null) { u = iu; }
                    else if (u !== iu) { u = ''; }
                }
            };
            scan(nd.in);
            scan(nd.out);
            return u || '';
        }

        /** A number on the ribbon itself, at the midpoint of the flow. */
        function drawLinkValue(parent, l, cfg, t, o, px, py, curv) {
            var font = o.font * 0.9;
            // A label taller than its own ribbon does not belong to it any more.
            if (l.w < font * 0.95) { return; }

            // Midpoint of the two Bezier edges at t = 0.5. With the control
            // abscissae placed symmetrically that is simply the average of the
            // two ends along the flow, and the average of the two centres
            // across it.
            var a = (l.source.a1 + l.target.a0) / 2;
            var c = ((l.sc + l.w / 2) + (l.tc + l.w / 2)) / 2;

            var txt = valueText(l.value, l.units, cfg);
            var node = PVX.svg.text(parent, px(a, c).toFixed(2), py(a, c).toFixed(2),
                truncate(txt, Math.abs(l.target.a0 - l.source.a1) * 0.9, font), {
                    'class': 'pvx-svg-value pvx-num pvx-sk-linkvalue',
                    'text-anchor': 'middle',
                    'font-size': font.toFixed(1),
                    fill: t.text,
                    stroke: o.surface, 'stroke-width': 2.4, 'stroke-linejoin': 'round'
                });
            if (!fitTextTo(node, Math.abs(l.target.a0 - l.source.a1) * 0.9)) {
                parent.removeChild(node);
            }
        }

        /* ================================================================ *
         * Empty state
         * ================================================================ */

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);
            var avail = Math.max(24, W - 12);

            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2),
                headline, {
                    'class': 'pvx-svg-label pvx-sk-emptymsg', 'text-anchor': 'middle',
                    'font-size': font, 'font-weight': '600', fill: t.textMuted
                });
            var sub = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2),
                detail, {
                    'class': 'pvx-svg-label pvx-sk-emptymsg', 'text-anchor': 'middle',
                    'font-size': (font * 0.85).toFixed(1), fill: t.textMuted
                });

            // Centre-anchored text spills past BOTH edges once it is wider than
            // the frame, which is the most obviously broken thing a symbol can
            // show. Nothing else is being drawn, so measure properly.
            shrinkToFit(head, avail);
            shrinkToFit(sub, avail);
        }

        /** Scale a <text> down until it fits, then truncate at the 6px floor. */
        function shrinkToFit(node, avail) {
            if (!node || !node.getComputedTextLength || !(avail > 0)) { return; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            var w = measure();
            if (!(w > avail)) { return; }

            var size = parseFloat(node.getAttribute('font-size')) || 10;
            node.setAttribute('font-size', Math.max(6, size * (avail / w)).toFixed(1));

            w = measure();
            if (!(w > avail)) { return; }

            var str = node.textContent;
            var keep = Math.max(3, Math.floor(str.length * (avail / w)) - 1);
            node.textContent = str.slice(0, keep) + '…';
            for (var guard = 0; guard < 24 && measure() > avail && node.textContent.length > 2; guard++) {
                node.textContent = node.textContent.slice(0, -2) + '…';
            }
        }

        /* ================================================================ *
         * Chrome plumbing
         * ================================================================ */

        /** Theme tokens as CSS custom properties for the Angular-rendered chrome. */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
        }

        /* Rendering happens in a rAF, i.e. outside Angular's digest, so the
         * scope.pvx writes above need an explicit (guarded) digest. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
