//! Images handed to the webview as `data:` URLs: the CSP allows `img-src data:`, so no
//! custom protocol nor file access is needed. SVG is only ever shown through `<img>`, where
//! it cannot run scripts nor load anything.

/// Above this size an image is not previewed (it goes to the webview as base64).
pub const MAX_IMAGE_PREVIEW: usize = 8 * 1024 * 1024;

/// Media type of the images the webview can show, from the file extension.
pub fn media_type(path: &str) -> Option<&'static str> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// `data:` URL of `data`; `None` above [`MAX_IMAGE_PREVIEW`].
pub fn data_url(media: &str, data: &[u8]) -> Option<String> {
    (data.len() <= MAX_IMAGE_PREVIEW).then(|| format!("data:{media};base64,{}", base64(data)))
}

/// Standard base64 with padding (no dependency for this one use).
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64_with_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe]), "//4=");
    }

    #[test]
    fn knows_the_web_image_types() {
        assert_eq!(media_type("a/b.PNG"), Some("image/png"));
        assert_eq!(media_type("x.svg"), Some("image/svg+xml"));
        assert_eq!(media_type("x.jpeg"), Some("image/jpeg"));
        assert_eq!(media_type("x.webp"), Some("image/webp"));
        assert_eq!(media_type("x.txt"), None);
        assert_eq!(media_type("noext"), None);
    }

    #[test]
    fn refuses_huge_images() {
        assert!(data_url("image/png", &vec![0; MAX_IMAGE_PREVIEW + 1]).is_none());
        assert_eq!(
            data_url("image/png", b"foo").as_deref(),
            Some("data:image/png;base64,Zm9v")
        );
    }
}
