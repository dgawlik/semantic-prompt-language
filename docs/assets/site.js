(() => {
    const announcement = document.querySelector('#announcement');
    const announce = (message) => { announcement.textContent = message; };
    const themeButton = document.querySelector('.theme-toggle');
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    const effectiveTheme = () => document.documentElement.dataset.theme || (systemTheme.matches ? 'dark' : 'light');
    const updateThemeLabel = () => {
        themeButton.setAttribute('aria-label', `Switch to ${effectiveTheme() === 'dark' ? 'light' : 'dark'} theme`);
    };
    updateThemeLabel();
    themeButton.hidden = false;
    systemTheme.addEventListener('change', updateThemeLabel);
    themeButton.addEventListener('click', () => {
        const theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = theme;
        updateThemeLabel();
        try {
            localStorage.setItem('spl-theme', theme);
            announce(`${theme === 'dark' ? 'Dark' : 'Light'} theme enabled.`);
        } catch (error) {
            console.warn('Could not save theme preference.', error);
            announce('Theme changed for this page, but your browser could not save the preference.');
        }
    });

    for (const button of document.querySelectorAll('[data-copy]')) {
        button.hidden = false;
        button.addEventListener('click', async () => {
            const code = document.getElementById(button.dataset.copy);
            const label = button.querySelector('span');
            try {
                if (!navigator.clipboard?.writeText) throw new Error('The Clipboard API is unavailable in this browser context.');
                await navigator.clipboard.writeText(code.textContent.replace(/\n$/, ''));
                label.textContent = 'Copied';
                announce('Code copied to clipboard.');
            } catch (error) {
                console.error('Could not copy code.', error);
                const selection = getSelection();
                const range = document.createRange();
                range.selectNodeContents(code);
                selection.removeAllRanges();
                selection.addRange(range);
                label.textContent = 'Selected';
                announce('Copy failed. Code is selected; use your keyboard or browser copy command.');
            }
            setTimeout(() => { label.textContent = 'Copy'; }, 2000);
        });
    }

    const dialog = document.querySelector('.search-dialog');
    const input = document.querySelector('#search-input');
    const results = document.querySelector('#search-results');
    const status = document.querySelector('#search-status');
    const trigger = document.querySelector('[data-open-search]');
    const index = window.SPL_SEARCH_INDEX;
    if (!Array.isArray(index)) {
        console.error('The documentation search index could not be loaded.');
        announce('Documentation search is unavailable. Use the page navigation to browse.');
    } else {
        trigger.hidden = false;
        const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318 K' : 'Ctrl K';
        trigger.querySelector('kbd').textContent = shortcut;
        const span = (className, text) => {
            const element = document.createElement('span');
            element.className = className;
            element.textContent = text;
            return element;
        };
        const renderResults = () => {
            const query = input.value.trim().toLocaleLowerCase();
            const terms = query.split(/\s+/).filter(Boolean);
            const matches = index.map((entry) => {
                const title = entry.title.toLocaleLowerCase();
                const text = `${entry.page} ${entry.text}`.toLocaleLowerCase();
                const signatureMatch = (entry.signatures || []).some((signature) => terms.some((term) => signature.toLocaleLowerCase().startsWith(term)));
                const score = terms.every((term) => title.includes(term) || text.includes(term))
                    ? terms.reduce((sum, term) => sum + (title === term ? 50 : title.startsWith(term) ? 25 : title.includes(term) ? 15 : 1), signatureMatch ? 20 : 0) : -1;
                return { entry, score };
            }).filter(({ entry, score }) => query ? score >= 0 : !entry.href.includes('#'))
                .sort((a, b) => b.score - a.score).slice(0, 10);
            results.replaceChildren();
            for (const { entry } of matches) {
                const item = document.createElement('li');
                const link = document.createElement('a');
                link.href = entry.href;
                link.append(span('search-result-page', `${entry.group} / ${entry.page}`), span('search-result-title', entry.title));
                if (entry.text) {
                    const match = terms.length ? entry.text.toLocaleLowerCase().indexOf(terms[0]) : 0;
                    const start = Math.max(0, match - 45);
                    link.append(span('search-result-excerpt', `${start ? '... ' : ''}${entry.text.slice(start, start + 185)}`));
                }
                item.append(link);
                results.append(item);
            }
            status.textContent = query
                ? matches.length ? `${matches.length} result${matches.length === 1 ? '' : 's'}${matches.length === 10 ? ' shown' : ''} for "${input.value.trim()}"` : 'No results. Try a function name, a concept, or fewer words.'
                : 'Explore the documentation, or type to search.';
        };
        const openSearch = () => {
            if (!dialog.open) dialog.showModal();
            renderResults();
            input.focus();
            input.select();
        };
        trigger.addEventListener('click', openSearch);
        input.addEventListener('input', renderResults);
        input.addEventListener('keydown', (event) => {
            if (event.isComposing) return;
            const first = results.querySelector('a');
            if (first && (event.key === 'ArrowDown' || event.key === 'Enter')) {
                event.preventDefault();
                if (event.key === 'Enter') first.click();
                else first.focus();
            }
        });
        results.addEventListener('keydown', (event) => {
            if (event.isComposing || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            const links = [...results.querySelectorAll('a')];
            const current = links.indexOf(document.activeElement);
            if (current < 0) return;
            event.preventDefault();
            const next = event.key === 'ArrowDown' ? links[current + 1] : links[current - 1];
            (next || (event.key === 'ArrowUp' ? input : links[current])).focus();
        });
        results.addEventListener('click', (event) => {
            if (event.target.closest('a')) dialog.close();
        });
        dialog.addEventListener('keydown', (event) => {
            // Embedded browsers can reserve native dialog dismissal for the host.
            if (event.key === 'Escape' && !event.isComposing) {
                event.preventDefault();
                dialog.close();
            }
        });
        dialog.addEventListener('click', (event) => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
        });
        document.addEventListener('keydown', (event) => {
            if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                if (dialog.open) dialog.close();
                else openSearch();
            }
        });
    }

    const tocLinks = [...document.querySelectorAll('.toc-links a')];
    const headings = [...document.querySelectorAll('.prose h2, .prose h3, .prose h4')];
    if ('IntersectionObserver' in window && headings.length) {
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                for (const link of tocLinks) {
                    if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'location');
                    else link.removeAttribute('aria-current');
                }
            }
        }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });
        for (const heading of headings) observer.observe(heading);
    }
})();
