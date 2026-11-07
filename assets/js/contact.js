/*
 * Contact link helper.
 *
 * The email address is deliberately not written in the page HTML, so simple
 * crawlers that harvest "mailto:" links and plain-text addresses don't find it.
 * Any element with a data-contact attribute opens the visitor's email app when
 * clicked; the address is only assembled at that moment.
 *
 * This deters basic scrapers only. For real protection, replace this with a
 * contact form that sends mail server-side.
 */
(function () {
    var parts = ['con', 'tact', 'logos', 'hub', 'org'];

    function address() {
        return parts[0] + parts[1] + '@' + parts[2] + parts[3] + '.' + parts[4];
    }

    document.addEventListener('click', function (event) {
        var link = event.target.closest('[data-contact]');
        if (!link) {
            return;
        }
        event.preventDefault();
        window.location.href = 'mailto:' + address();
    });
})();
