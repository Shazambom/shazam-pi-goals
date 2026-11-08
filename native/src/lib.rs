mod checkpoint;
mod trace;

use napi::{bindgen_prelude::AsyncTask, Env, Error, Result, Task};
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
pub fn checkpoint_verify_saved(
    file: String,
    session_id: String,
    entries: String,
) -> AsyncTask<VerifySavedTask> {
    AsyncTask::new(VerifySavedTask {
        file,
        session_id,
        entries,
    })
}

pub struct VerifySavedTask {
    file: String,
    session_id: String,
    entries: String,
}
impl Task for VerifySavedTask {
    type Output = bool;
    type JsValue = bool;
    fn compute(&mut self) -> Result<bool> {
        Ok(checkpoint::verify_saved(
            &self.file,
            &self.session_id,
            &parse(&self.entries)?,
        ))
    }
    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}

#[napi]
pub struct NativeTrace {
    recorder: Option<trace::Recorder>,
}
#[napi]
impl NativeTrace {
    #[napi(constructor)]
    pub fn new(directory: String, options: String) -> Result<Self> {
        Ok(Self {
            recorder: Some(
                trace::Recorder::new(&directory, parse(&options)?).map_err(Error::from_reason)?,
            ),
        })
    }
    #[napi]
    pub fn begin_session(&mut self) {
        if let Some(recorder) = &mut self.recorder {
            recorder.begin_session();
        }
    }
    #[napi]
    pub fn event(&mut self, kind: String, input: String) -> Result<()> {
        if let Some(recorder) = &mut self.recorder {
            recorder.event(&kind, parse(&input)?);
        }
        Ok(())
    }
    #[napi]
    pub fn summary(&mut self) -> String {
        self.recorder
            .as_mut()
            .map(|r| r.summary())
            .unwrap_or_else(|| "Trace recorder closed".into())
    }
    #[napi]
    pub fn close(&mut self) -> AsyncTask<CloseTask> {
        AsyncTask::new(CloseTask(self.recorder.take()))
    }
}

pub struct CloseTask(Option<trace::Recorder>);
impl Task for CloseTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        if let Some(mut recorder) = self.0.take() {
            recorder.close();
        }
        Ok(())
    }
    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}
