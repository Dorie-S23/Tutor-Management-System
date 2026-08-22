document.getElementById("logout-button")?.addEventListener("click", (event) => {
    event.preventDefault();

    sessionStorage.removeItem("access_token");
    sessionStorage.removeItem("user");

    window.location.href = "login.html";
});
