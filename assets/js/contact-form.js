/*
 * Contact form: sends the message to /api/contact (a Cloudflare Pages Function).
 * `elapsed` is how long the page has been open; the server uses it, together
 * with the hidden "company_url" field, to turn away simple bots.
 */
(function () {
    var form = document.getElementById('contact-form');
    if (!form) {
        return;
    }

    var status = document.getElementById('form-status');
    var button = form.querySelector('button[type="submit"]');

    function show(message, kind) {
        status.textContent = message;
        status.className = 'form-status ' + kind;
    }

    form.addEventListener('submit', function (event) {
        event.preventDefault();

        var name = form.elements.name.value.trim();
        var email = form.elements.email.value.trim();
        var message = form.elements.message.value.trim();

        if (!name) {
            show('Please enter your name.', 'error');
            form.elements.name.focus();
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            show('Please enter a valid email address.', 'error');
            form.elements.email.focus();
            return;
        }
        if (message.length < 10) {
            show('Please write a message of at least 10 characters.', 'error');
            form.elements.message.focus();
            return;
        }

        button.disabled = true;
        show('Sending...', 'info');

        fetch('/api/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                email: email,
                message: message,
                company_url: form.elements.company_url.value,
                elapsed: Math.round(performance.now())
            })
        })
            .then(function (response) {
                return response.json().catch(function () {
                    return { ok: false };
                });
            })
            .then(function (data) {
                if (data && data.ok) {
                    form.reset();
                    show('Thank you. Your message has been sent.', 'success');
                } else {
                    show((data && data.error) || "Sorry, we couldn't send your message. Please try again later.", 'error');
                }
            })
            .catch(function () {
                show("Sorry, we couldn't reach the server. Please check your connection and try again.", 'error');
            })
            .then(function () {
                button.disabled = false;
            });
    });
})();
