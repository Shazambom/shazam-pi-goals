mod checkpoint;

use napi::{Error, Result};
use napi_derive::napi;
use serde_json::Value;

fn parse(input: &str) -> Result<Value> {
    serde_json::from_str(input).map_err(|_| Error::from_reason("invalid_json"))
}
fn encode(value: Value) -> Result<String> {
    serde_json::to_string(&value).map_err(|_| Error::from_reason("serialization_failed"))
}
#[napi]
pub fn checkpoint_restore(entries: String) -> Result<String> {
    encode(checkpoint::restore(&parse(&entries)?))
}
#[napi]
pub fn checkpoint_replace(view: String, revision: String, note: String) -> Result<String> {
    encode(
        checkpoint::replacement(&parse(&view)?, &parse(&revision)?, &parse(&note)?)
            .map_err(Error::from_reason)?,
    )
}
#[napi]
pub fn checkpoint_control(action: String) -> Result<String> {
    encode(checkpoint::control(&action).map_err(Error::from_reason)?)
}
#[napi]
pub fn checkpoint_render(view: String) -> Result<Option<String>> {
    Ok(checkpoint::render(&parse(&view)?))
}
#[napi]
pub fn checkpoint_verify_saved(file: String, session_id: String, entries: String) -> Result<bool> {
    Ok(checkpoint::verify_saved(
        &file,
        &session_id,
        &parse(&entries)?,
    ))
}

